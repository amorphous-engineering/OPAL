/** Self-updater: newest release for this channel, SHA-256 verified, binary swap with rollback. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, renameSync, rmSync, statSync, accessSync, constants } from 'node:fs';
import { basename, dirname } from 'node:path';
import { VERSION } from '../version.ts';

export const RELEASES_URL = 'https://api.github.com/repos/amorphous-engineering/OPAL/releases/latest';
/** GitHub's Latest is never a prerelease, so a prerelease build reads the whole list instead. */
export const ALL_RELEASES_URL = 'https://api.github.com/repos/amorphous-engineering/OPAL/releases?per_page=30';

// TODO(Phase 1): verify the minisign signature of SHA256SUMS before trusting it.
// A checksum from the same release only guards against corrupt downloads, not a hijacked release.

export interface UpdaterOptions {
	/** Release metadata URL: one release, or a list of them. Tests point this at a local server. */
	apiUrl?: string;
	currentVersion?: string;
	platform?: string;
	arch?: string;
	fetch?: typeof fetch;
	log?: (message: string) => void;
}

export interface UpdateInfo {
	tag: string;
	version: string;
	current: string;
	body: string;
	assetName: string;
	assetUrl: string;
	sumsUrl: string | null;
}

/** True when running as a `bun build --compile` binary. Its entry script lives in the virtual
 * `/$bunfs/` (`B:/~BUN/` on Windows) filesystem; under `bun src/cli.ts` it is a real path. */
export function isCompiled(): boolean {
	return Bun.main.startsWith('/$bunfs/') || Bun.main.includes('~BUN');
}

// --- versions ---------------------------------------------------------------------------

export interface Semver {
	major: number;
	minor: number;
	patch: number;
	pre: string[];
}

export function parseSemver(input: string): Semver | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(input.trim());
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] ? m[4].split('.') : []
	};
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareSemver(a: Semver, b: Semver): number {
	for (const k of ['major', 'minor', 'patch'] as const) {
		if (a[k] !== b[k]) return a[k] - b[k];
	}
	if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
	for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
		const x = a.pre[i];
		const y = b.pre[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) {
			if (Number(x) !== Number(y)) return Number(x) - Number(y);
		} else if (nx !== ny) return nx ? -1 : 1;
		else if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

// --- assets and checksums -----------------------------------------------------------------

export function assetName(platform: string = process.platform, arch: string = process.arch): string {
	const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : null;
	const cpu = arch === 'x64' || arch === 'x86_64' ? 'x86_64' : arch === 'arm64' || arch === 'aarch64' ? 'arm64' : null;
	const name = os && cpu ? `opal-${os}-${cpu}${os === 'windows' ? '.exe' : ''}` : null;
	const supported = ['opal-macos-arm64', 'opal-macos-x86_64', 'opal-linux-x86_64', 'opal-linux-arm64', 'opal-windows-x86_64.exe'];
	if (!name || !supported.includes(name)) throw new Error(`No release binary for ${platform}/${arch}`);
	return name;
}

export function sha256Hex(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Parse `sha256sum` output: `<hex>  <name>` or `<hex> *<name>`. */
export function parseSums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
		if (m) sums.set(basename(m[2]!), m[1]!.toLowerCase());
	}
	return sums;
}

/** Throws unless `sumsText` lists `name` and the hash matches. */
export function verifyChecksum(data: Uint8Array, sumsText: string | null, name: string): void {
	if (sumsText === null) throw new Error('Release has no SHA256SUMS; refusing to install');
	const expected = parseSums(sumsText).get(name);
	if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}; refusing to install`);
	const actual = sha256Hex(data);
	if (actual !== expected) {
		throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
	}
}

// --- check, download ----------------------------------------------------------------------

interface ReleaseJson {
	tag_name?: string;
	body?: string;
	draft?: boolean;
	published_at?: string;
	assets?: { name?: string; browser_download_url?: string }[];
}

/**
 * The highest version in a release list that this machine can install. A release still uploading
 * has no binary yet: it is skipped, so the next check finds it. Version order alone is not enough:
 * `2.0.0-rc.25` sorts above `2.0.0-beta.1` though it came first, so a release published before the
 * running one is never offered.
 */
function newestInstallable(list: ReleaseJson[], name: string, current: Semver): ReleaseJson | null {
	const running = list.find((r) => {
		const version = parseSemver(r.tag_name ?? '');
		return version !== null && compareSemver(version, current) === 0;
	})?.published_at;
	let best: ReleaseJson | null = null;
	let bestVersion: Semver | null = null;
	for (const release of list) {
		if (release.draft) continue;
		const version = parseSemver(release.tag_name ?? '');
		// Old tags such as `v1.3.0b1` are in the list for good, so they are not worth a warning.
		if (!version || !release.assets?.some((a) => a.name === name)) continue;
		if (running && release.published_at && release.published_at <= running) continue;
		if (!bestVersion || compareSemver(version, bestVersion) > 0) {
			best = release;
			bestVersion = version;
		}
	}
	return best;
}

/**
 * Returns the update when a newer release exists, else null. A stable build follows the release
 * marked Latest. A prerelease build also follows prereleases, or a tester would stay on their
 * first beta for good.
 */
export async function checkForUpdate(opts: UpdaterOptions = {}): Promise<UpdateInfo | null> {
	const f = opts.fetch ?? fetch;
	const log = opts.log ?? ((m) => console.warn(m));
	const current = opts.currentVersion ?? VERSION;
	const cur = parseSemver(current);
	if (!cur) {
		log(`Ignoring update check: current version ${JSON.stringify(current)} is not semver`);
		return null;
	}
	const url = opts.apiUrl ?? process.env.OPAL_UPDATE_API ?? (cur.pre.length ? ALL_RELEASES_URL : RELEASES_URL);
	const res = await f(url, {
		headers: { accept: 'application/vnd.github+json', 'user-agent': 'opal-updater' },
		signal: AbortSignal.timeout(15_000)
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Release lookup failed: HTTP ${res.status}`);
	const answer = (await res.json()) as ReleaseJson | ReleaseJson[];
	const data = Array.isArray(answer) ? newestInstallable(answer, assetName(opts.platform, opts.arch), cur) : answer;
	if (!data) return null;
	const tag = data.tag_name ?? '';
	const latest = parseSemver(tag);
	if (!latest) {
		log(`Ignoring release with malformed tag ${JSON.stringify(tag)}`);
		return null;
	}
	if (compareSemver(latest, cur) <= 0) return null;
	const name = assetName(opts.platform, opts.arch);
	const assets = data.assets ?? [];
	const asset = assets.find((a) => a.name === name);
	if (!asset?.browser_download_url) throw new Error(`Release ${tag} has no asset ${name}`);
	const sums = assets.find((a) => a.name === 'SHA256SUMS');
	return {
		tag,
		version: tag.replace(/^v/, ''),
		current,
		body: data.body ?? '',
		assetName: name,
		assetUrl: asset.browser_download_url,
		sumsUrl: sums?.browser_download_url ?? null
	};
}

async function getBytes(f: typeof fetch, url: string): Promise<Uint8Array> {
	const res = await f(url, { headers: { 'user-agent': 'opal-updater' }, redirect: 'follow' });
	if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
	return new Uint8Array(await res.arrayBuffer());
}

/** Clear error when the directory of the binary cannot take new files. */
export function assertWritable(binary: string): void {
	try {
		accessSync(dirname(binary), constants.W_OK);
		accessSync(binary, constants.W_OK);
	} catch {
		throw new Error(
			`Cannot write to ${binary}. Move OPAL to a folder you can write to, or run the update with the right permissions.`
		);
	}
}

/** Download the binary and SHA256SUMS, verify, and write `<binary>.new` next to the target
 * (same filesystem, so the later rename is atomic). Nothing is written when verification fails. */
export async function downloadUpdate(info: UpdateInfo, binary: string, opts: UpdaterOptions = {}): Promise<string> {
	const f = opts.fetch ?? fetch;
	assertWritable(binary);
	const data = await getBytes(f, info.assetUrl);
	const sums = info.sumsUrl ? new TextDecoder().decode(await getBytes(f, info.sumsUrl)) : null;
	verifyChecksum(data, sums, info.assetName);
	const staged = `${binary}.new`;
	await Bun.write(staged, data);
	return staged;
}

// --- swap, rollback -----------------------------------------------------------------------

export const oldPath = (binary: string) => `${binary}.old`;

/** Rename the running binary to `<name>.old`, move `staged` into its place, chmod +x. */
export function swapBinary(binary: string, staged: string): void {
	assertWritable(binary);
	const old = oldPath(binary);
	rmSync(old, { force: true });
	renameSync(binary, old);
	try {
		renameSync(staged, binary);
		if (process.platform !== 'win32') chmodSync(binary, statSync(binary).mode | 0o111);
	} catch (e) {
		renameSync(old, binary);
		throw new Error(`Cannot install new binary at ${binary}: ${(e as Error).message}. Original restored.`);
	}
}

/** Put `<name>.old` back. Returns false when there is nothing to restore. */
export function rollbackBinary(binary: string): boolean {
	const old = oldPath(binary);
	if (!existsSync(old)) return false;
	rmSync(binary, { force: true });
	renameSync(old, binary);
	return true;
}

/** Check, download, verify, swap. Used by `opal update`. Returns null when up to date. */
export async function installUpdate(binary: string, opts: UpdaterOptions = {}): Promise<UpdateInfo | null> {
	if (!isCompiled()) throw new Error('Updates need the compiled opal binary; this is a development run.');
	const info = await checkForUpdate(opts);
	if (!info) return null;
	swapBinary(binary, await downloadUpdate(info, binary, opts));
	return info;
}
