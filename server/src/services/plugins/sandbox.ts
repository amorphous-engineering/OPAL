/**
 * Keeps a plugin process away from everything but its own folder, where the operating system lets us.
 *
 * Linux, not root: Landlock and a seccomp filter (sandbox-launcher.js). No second user is needed, and
 * unprivileged namespaces are not an option, since current Ubuntu refuses them by default.
 * Linux, root: a user id of its own, then the same restrictions when the kernel has them. Root must
 * go first, because Landlock alone leaves a process with all of root's capabilities.
 * macOS, Windows: nothing yet. The plugin runs as OPAL does, and says so (README, process view, log).
 *
 * Each launch asks the launcher to confine itself and report before the real run, so `confinement`
 * states what the kernel did on this machine for this plugin, not what the platform should allow.
 */
import type { PluginConfinement } from '@opal/shared';
import { chmodSync, chownSync, lchownSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, dbPath } from '../../paths.ts';
import launcherSource from './sandbox-launcher.js' with { type: 'text' };

/**
 * `required`: a plugin that cannot be confined does not start. `off`: never confine.
 * Anything else that is not `auto` counts as `required`, so a typo does not lower the protection.
 */
export function confinementPolicy(): 'auto' | 'required' | 'off' {
	const value = process.env.OPAL_PLUGIN_CONFINEMENT?.trim().toLowerCase();
	if (!value || value === 'auto') return 'auto';
	return value === 'off' ? 'off' : 'required';
}

/** Read-only for the plugin. Paths a system does not have are skipped. */
const SYSTEM_READ = [
	'/usr',
	'/lib',
	'/lib32',
	'/lib64',
	'/libx32',
	'/bin',
	'/sbin',
	'/nix/store',
	// A runtime's main thread reads its own maps. Other processes' memory, environment and open files
	// stay shut, because Landlock refuses ptrace-level access across the boundary. What remains is
	// what any other user on the machine sees: `ps`, /proc/net, /proc/sys.
	'/proc'
];
/** DNS, TLS, the dynamic linker, time zones and user names, and nothing else from /etc. */
const SYSTEM_READ_ETC = [
	'resolv.conf',
	'hosts',
	'host.conf',
	'nsswitch.conf',
	'gai.conf',
	'services',
	'protocols',
	'ssl',
	'ca-certificates',
	'crypto-policies',
	'pki',
	'localtime',
	'timezone',
	'passwd',
	'group',
	'ld.so.cache',
	'ld.so.conf',
	'ld.so.conf.d',
	'mime.types'
].map((name) => `/etc/${name}`);
const DEVICES = ['/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom'];

/** A range systemd documents as unused, and far from anything a person or a container holds. */
const PLUGIN_UID_BASE = 1_900_000_000;

export interface PluginStart {
	/** The plugin row's id. Rows are never renumbered, so one plugin keeps one user id. */
	id: number;
	code: string;
	main: string;
	data: string;
	/** A local source runs from someone's own folder. OPAL does not change that folder's owner. */
	local: boolean;
	env: Record<string, string>;
}

export interface PluginLaunch {
	cmd: string[];
	cwd: string;
	env: Record<string, string>;
	confinement: PluginConfinement;
	/** One line for the plugin's log. */
	note: string;
}

export class ConfinementRefused extends Error {}

/** For tests: this machine's answer, which real launches do not take from a variable. */
interface Machine {
	platform: NodeJS.Platform;
	uid: number;
}
const thisMachine = (): Machine => ({ platform: process.platform, uid: process.getuid?.() ?? -1 });

function unconfined(start: PluginStart, why: string): PluginLaunch {
	if (confinementPolicy() === 'required') {
		throw new ConfinementRefused(`Plugin not started: OPAL_PLUGIN_CONFINEMENT requires confinement. ${why}`);
	}
	return {
		cmd: [process.execPath, join(start.code, start.main)],
		cwd: start.code,
		env: start.env,
		confinement: 'none',
		note: `Not confined: ${why} This plugin can read everything OPAL can, including the database.`
	};
}

export async function planLaunch(start: PluginStart, machine: Machine = thisMachine()): Promise<PluginLaunch> {
	if (confinementPolicy() === 'off') return unconfined(start, 'OPAL_PLUGIN_CONFINEMENT is off.');
	if (machine.platform !== 'linux') return unconfined(start, `OPAL has no confinement on ${machine.platform}.`);

	const asRoot = machine.uid === 0;
	const user = asRoot ? { uid: PLUGIN_UID_BASE + start.id, gid: PLUGIN_UID_BASE + start.id } : {};
	if (asRoot) {
		try {
			openFoldersFor(start, PLUGIN_UID_BASE + start.id);
		} catch (e) {
			return unconfined(start, `Could not give the plugin its own user: ${(e as Error).message}.`);
		}
	}

	const tmp = join(start.data, '.tmp');
	const spec = {
		exec: process.execPath,
		argv: [process.execPath, join(start.code, start.main)],
		cwd: start.code,
		tmp,
		read: [...SYSTEM_READ, ...SYSTEM_READ_ETC, ...caFiles(start.env), process.execPath, start.code],
		write: [start.data],
		devices: DEVICES,
		forbidden: [dbPath(), join(dataDir(), '.opal_auth_secret'), dataDir()],
		// Applied at the moment of exec. The launcher itself runs with no HOME: the plugin can write to
		// this one, and nothing it wrote may be near a runtime that has not been confined yet.
		env: { HOME: start.data, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
		...user
	};
	const report = await probe(spec);
	if (!report.ok) return unconfined(start, `${report.reason}.`);

	const { HOME: _home, TMPDIR: _tmpdir, TMP: _tmp, TEMP: _temp, USERPROFILE: _profile, ...launcherEnv } = start.env;
	return {
		cmd: [process.execPath, '-e', launcherSource],
		// Bun reads config and env files from the working folder, so not the plugin's.
		cwd: '/',
		env: { ...launcherEnv, OPAL_SANDBOX_SPEC: JSON.stringify(spec) },
		confinement: asRoot ? 'separate-user' : 'landlock',
		note: asRoot
			? `Confined: user id ${PLUGIN_UID_BASE + start.id}${report.abi ? `, Landlock ABI ${report.abi}` : ', no Landlock'}.`
			: `Confined: Landlock ABI ${report.abi} and a seccomp filter.`
	};
}

const caFiles = (env: Record<string, string>) =>
	[env.NODE_EXTRA_CA_CERTS, env.SSL_CERT_FILE].filter((p): p is string => Boolean(p));

async function probe(spec: object): Promise<{ ok: boolean; reason?: string; abi?: number }> {
	const proc = Bun.spawn([process.execPath, '-e', launcherSource], {
		cwd: '/',
		env: { BUN_BE_BUN: '1', OPAL_SANDBOX_SPEC: JSON.stringify({ ...spec, probe: true }) },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	try {
		return JSON.parse(out) as { ok: boolean; reason?: string; abi?: number };
	} catch {
		return { ok: false, reason: `the confinement check did not finish: ${err.trim().slice(0, 200) || 'no output'}` };
	}
}

/**
 * Root only. The plugin's user must walk into the data folder, read its code and own its data. Mode
 * 0711 lets it through the shared folders without listing them; what they hold stays owner-only.
 */
function openFoldersFor(start: PluginStart, id: number): void {
	const key = dirname(start.code);
	const shared = [dataDir(), dirname(start.data)];
	if (!start.local) shared.push(dirname(key), key);
	for (const dir of shared) chmodSync(dir, 0o711);
	if (!start.local) giveCode(start.code, id);
	// Once only. After this the folder is the plugin's, and root must not walk a tree it can rearrange.
	if (statSync(start.data).uid !== id) giveTree(start.data, id);
	chmodSync(start.data, 0o700);
}

/** The code stays root's, so a plugin cannot rewrite what it will run next time. */
function giveCode(path: string, gid: number): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) return;
	chownSync(path, 0, gid);
	if (st.isDirectory()) {
		chmodSync(path, 0o750);
		for (const name of readdirSync(path)) giveCode(join(path, name), gid);
	} else {
		chmodSync(path, st.mode & 0o100 ? 0o750 : 0o640);
	}
}

function giveTree(path: string, id: number): void {
	lchownSync(path, id, id);
	if (!lstatSync(path).isDirectory()) return;
	for (const name of readdirSync(path)) giveTree(join(path, name), id);
}
