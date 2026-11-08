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
 *
 * It fails closed. Under `auto`, a plugin runs unconfined only where the system offers nothing: not
 * Linux, or a Linux kernel without Landlock, and then never as root. Any other failure, including
 * one the plugin or its folder could cause, keeps the plugin stopped.
 */
import type { PluginConfinement } from '@opal/shared';
import { chmodSync, chownSync, lchownSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, dbPath } from '../../paths.ts';
import { confinementPolicy } from './policy.ts';
import launcherSource from './sandbox-launcher.js' with { type: 'text' };

export { confinementPolicy };

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

/** Stands until the operator changes something, so the host waits the longest before trying again. */
export class ConfinementRefused extends Error {}

/** For tests: this machine's answer, which real launches do not take from a variable. */
interface Machine {
	platform: NodeJS.Platform;
	uid: number;
	probeTimeoutMs?: number;
}
const thisMachine = (): Machine => ({ platform: process.platform, uid: process.getuid?.() ?? -1 });

export interface ProbeReport {
	ok: boolean;
	/** `no-landlock`: the kernel has none. Set only for that, which a plugin cannot cause. */
	kind?: string;
	reason?: string;
	abi?: number;
}

/** What a probe allows. Only a kernel without Landlock lets a plugin run unconfined, and not as root. */
export function decide(report: ProbeReport, asRoot: boolean): 'confined' | 'unconfined' | 'refused' {
	if (report.ok) return 'confined';
	if (!asRoot && report.kind === 'no-landlock') return 'unconfined';
	return 'refused';
}

function refuse(why: string): never {
	throw new ConfinementRefused(
		`Plugin not started: it could not be confined. ${why} Only OPAL_PLUGIN_CONFINEMENT=off runs it without confinement.`
	);
}

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
	const id = PLUGIN_UID_BASE + start.id;
	const user = asRoot ? { uid: id, gid: id } : {};
	const tmp = join(start.data, '.tmp');
	try {
		if (asRoot) openFoldersFor(start, id);
		else ownedBy(start, machine.uid);
		makeTemp(tmp, asRoot ? id : undefined);
	} catch (e) {
		if (e instanceof ConfinementRefused) throw e;
		refuse(`${asRoot ? 'Could not give the plugin its own user: ' : ''}${(e as Error).message}.`);
	}

	const spec = {
		exec: process.execPath,
		argv: [process.execPath, join(start.code, start.main)],
		cwd: start.code,
		tmp,
		read: [...SYSTEM_READ, ...SYSTEM_READ_ETC, ...caFiles(start.env), process.execPath, start.code],
		write: [start.data],
		devices: DEVICES,
		forbidden: [
			...[dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`],
			...['.opal_auth_secret', '.opal_secrets_key', '.opal_secrets_key.tmp'].map((f) => join(dataDir(), f)),
			dataDir()
		],
		// Applied at the moment of exec. The launcher itself runs with no HOME: the plugin can write to
		// this one, and nothing it wrote may be near a runtime that has not been confined yet.
		env: { HOME: start.data, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
		...user
	};
	const report = await probe(spec, machine.probeTimeoutMs);
	const verdict = decide(report, asRoot);
	if (verdict === 'unconfined') return unconfined(start, `${report.reason}.`);
	if (verdict === 'refused') refuse(`${report.reason}.`);

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

/**
 * A check that does not finish says nothing about this plugin, and may pass next time, so it throws
 * a plain error: the host keeps the plugin stopped and tries again on its usual backoff.
 */
async function probe(spec: object, timeout = 10_000): Promise<ProbeReport> {
	const proc = Bun.spawn([process.execPath, '-e', launcherSource], {
		cwd: '/',
		env: { BUN_BE_BUN: '1', OPAL_SANDBOX_SPEC: JSON.stringify({ ...spec, probe: true }) },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const timer = setTimeout(() => proc.kill('SIGKILL'), timeout);
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	clearTimeout(timer);
	if (proc.signalCode) throw new Error(`Plugin not started: the confinement check did not finish (${proc.signalCode}).`);
	try {
		return JSON.parse(out) as ProbeReport;
	} catch {
		throw new Error(`Plugin not started: the confinement check did not finish: ${err.trim().slice(0, 200) || 'no output'}`);
	}
}

/**
 * The plugin's temp folder. The server makes it, so nothing the plugin left in its own folder can
 * steer the check: anything there that is not a real folder stops the plugin.
 */
function makeTemp(tmp: string, uid: number | undefined): void {
	try {
		mkdirSync(tmp);
	} catch (e) {
		if ((e as { code?: string }).code !== 'EEXIST') throw e;
	}
	const st = lstatSync(tmp);
	if (!st.isDirectory()) throw new ConfinementRefused(`Plugin not started: ${tmp} is not a folder. Remove it and the plugin starts.`);
	// Made by root just now. lchown does not follow a link.
	if (uid !== undefined && st.uid !== uid) lchownSync(tmp, uid, uid);
}

/**
 * Not root. A folder an earlier run as root gave to the plugin's own user is out of this user's reach,
 * and it cannot take it back.
 */
function ownedBy(start: PluginStart, uid: number): void {
	for (const dir of start.local ? [start.data] : [start.data, start.code]) {
		const owner = statSync(dir).uid;
		if (owner !== uid) {
			throw new ConfinementRefused(
				`Plugin not started: ${dir} belongs to user id ${owner}, not to the user OPAL runs as, perhaps from an earlier run as root. Give it back with chown -R.`
			);
		}
	}
}

/**
 * Root only. The plugin's user must walk into the data folder, read its code and own its data. Mode
 * 0711 lets it through the shared folders without listing them; what they hold stays owner-only.
 * Owners change first: where they cannot (a container with mapped user ids), no mode is loosened.
 */
function openFoldersFor(start: PluginStart, id: number): void {
	const key = dirname(start.code);
	const shared = [dataDir(), dirname(start.data)];
	if (!start.local) shared.push(dirname(key), key);
	if (!start.local) giveCode(start.code, id);
	// Once only. After this the folder is the plugin's, and root must not walk a tree it can rearrange.
	if (statSync(start.data).uid !== id) giveTree(start.data, id);
	chmodSync(start.data, 0o700);
	for (const dir of shared) chmodSync(dir, 0o711);
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
