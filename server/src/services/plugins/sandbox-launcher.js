/**
 * First stage of a confined plugin on Linux. It runs with no plugin code loaded, gives up what the
 * plugin must not have, then replaces itself with the plugin's process. The restrictions only cover
 * the calling thread and the runtime has already started others, so exec is what makes them whole:
 * it ends those threads, and the pid the host watches stays the same.
 *
 * Runs through `bun -e` from any install, so it stands alone: no imports from the server.
 * What to do comes from OPAL_SANDBOX_SPEC (built in sandbox.ts), which is not passed on. The plugin
 * gets the rest of this environment, with spec.env on top.
 * On any failure it exits without starting the plugin.
 */
import { closeSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi';

const spec = JSON.parse(process.env.OPAL_SANDBOX_SPEC);

const ARCH = {
	x64: {
		audit: 0xc000003e,
		// The x32 ABI enters with this bit set and has its own numbers, so a filter must refuse it.
		x32Bit: 0x40000000,
		prctl: 157,
		execveat: 322,
		setgroups: 116,
		setresuid: 117,
		setresgid: 119,
		socket: 41,
		truncate: 76,
		metadata: [90, 92, 94, 260, 268],
		keys: [248, 249, 250]
	},
	arm64: {
		audit: 0xc00000b7,
		x32Bit: 0,
		prctl: 167,
		execveat: 281,
		setgroups: 159,
		setresuid: 147,
		setresgid: 149,
		socket: 198,
		truncate: 45,
		metadata: [53, 54],
		keys: [217, 218, 219]
	}
}[process.arch];

// Newer system calls have one number on every architecture.
const SYS = {
	landlockCreate: 444,
	landlockAddRule: 445,
	landlockRestrict: 446,
	closeRange: 436,
	fchmodat2: 452,
	ioUring: [425, 426, 427]
};

const PR_SET_NO_NEW_PRIVS = 38;
const PR_SET_SECCOMP = 22;
const SECCOMP_MODE_FILTER = 2;
const AT_EMPTY_PATH = 0x1000;
const CLOSE_RANGE_CLOEXEC = 4;
const O_PATH = 0o10000000;
const O_CLOEXEC = 0o2000000;
const AF_UNIX = 1;
const EPERM = 1;
const EACCES = 13;
const ENOSYS = 38;
const EOPNOTSUPP = 95;

const FS_EXECUTE = 1n << 0n;
const FS_WRITE_FILE = 1n << 1n;
const FS_READ_FILE = 1n << 2n;
const FS_READ_DIR = 1n << 3n;
const FS_REMOVE_DIR = 1n << 4n;
const FS_REMOVE_FILE = 1n << 5n;
const FS_MAKE_DIR = 1n << 7n;
const FS_MAKE_REG = 1n << 8n;
const FS_MAKE_FIFO = 1n << 10n;
const FS_MAKE_SYM = 1n << 12n;
const FS_REFER = 1n << 13n;
const FS_TRUNCATE = 1n << 14n;
const FS_IOCTL_DEV = 1n << 15n;
const SCOPE_ABSTRACT_UNIX_SOCKET = 1n;
const SCOPE_SIGNAL = 2n;

const libc = dlopen('libc.so.6', {
	syscall: {
		args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
		returns: FFIType.i64
	},
	__errno_location: { args: [], returns: FFIType.ptr }
}).symbols;

const errno = () => new Int32Array(toArrayBuffer(libc.__errno_location(), 0, 4))[0];

function sys(nr, a = 0, b = 0, c = 0, d = 0, e = 0) {
	const r = Number(libc.syscall(nr, a, b, c, d, e));
	if (r < 0) throw new SyscallError(nr, errno());
	return r;
}

class SyscallError extends Error {
	constructor(nr, code) {
		super(`system call ${nr} failed with errno ${code}`);
		this.code = code;
	}
}

const cstr = (s) => Buffer.from(`${s}\0`, 'utf8');

/** Groups first: after the user change the process may no longer change them. */
function dropUser(uid, gid) {
	sys(ARCH.setgroups, 0, 0);
	sys(ARCH.setresgid, gid, gid, gid);
	sys(ARCH.setresuid, uid, uid, uid);
}

function landlock() {
	let abi;
	try {
		abi = sys(SYS.landlockCreate, 0, 0, 1);
	} catch (e) {
		// Not built in, or turned off at boot. The server may run a plugin unconfined only for these,
		// because nothing a plugin does can cause them.
		if (e.code === ENOSYS || e.code === EOPNOTSUPP) {
			throw Object.assign(new Error(`this kernel does not offer Landlock (errno ${e.code})`), { kind: 'no-landlock' });
		}
		throw new Error(`the Landlock check failed with errno ${e.code}`);
	}
	let handled = (1n << 13n) - 1n;
	if (abi >= 2) handled |= FS_REFER;
	if (abi >= 3) handled |= FS_TRUNCATE;
	if (abi >= 5) handled |= FS_IOCTL_DEV;

	const attr = new BigUint64Array([handled, 0n, abi >= 6 ? SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL : 0n]);
	const ruleset = sys(SYS.landlockCreate, ptr(attr), attr.byteLength, 0);

	const readTree = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR;
	const writeTree =
		readTree |
		FS_WRITE_FILE |
		FS_REMOVE_DIR |
		FS_REMOVE_FILE |
		FS_MAKE_DIR |
		FS_MAKE_REG |
		FS_MAKE_FIFO |
		FS_MAKE_SYM |
		(abi >= 2 ? FS_REFER : 0n) |
		(abi >= 3 ? FS_TRUNCATE : 0n);
	const fileRights = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV;

	const allow = (path, rights) => {
		let fd;
		try {
			fd = openSync(path, O_PATH | O_CLOEXEC);
		} catch {
			return; // a path this system does not have
		}
		try {
			const isDir = statSync(path).isDirectory();
			// A rule on a file may carry file rights only.
			const allowed = (isDir ? rights : rights & fileRights) & handled;
			// struct landlock_path_beneath_attr is packed: u64 rights, s32 fd.
			const rule = Buffer.alloc(12);
			rule.writeBigUInt64LE(allowed, 0);
			rule.writeInt32LE(fd, 8);
			sys(SYS.landlockAddRule, ruleset, 1, ptr(rule), 0);
		} finally {
			closeSync(fd);
		}
	};
	for (const path of spec.read) allow(path, readTree);
	for (const path of spec.write) allow(path, writeTree);
	for (const path of spec.devices) allow(path, FS_READ_FILE | FS_WRITE_FILE | FS_IOCTL_DEV);

	sys(SYS.landlockRestrict, ruleset, 0);
	closeSync(ruleset);
	return abi;
}

/**
 * What Landlock does not cover: a same-user process could reach the desktop or service bus over a
 * Unix socket and ask it to start something outside the sandbox, read the user's kernel keyrings,
 * or change the mode and owner of files it cannot open. io_uring goes too, since it can make
 * sockets without passing through this filter.
 */
function seccomp(abi) {
	const LD_ABS_W = 0x20;
	const JEQ_K = 0x15;
	const JGE_K = 0x35;
	const RET_K = 0x06;
	const ALLOW = 0x7fff0000;
	const KILL_PROCESS = 0x80000000;
	const fail = (e) => 0x00050000 | e;

	const denied = [...ARCH.metadata, ...ARCH.keys, SYS.fchmodat2];
	// Before ABI 3, Landlock does not handle truncating a file by name.
	if (abi < 3) denied.push(ARCH.truncate);

	const prog = [];
	const stmt = (code, k, jt = 0, jf = 0) => prog.push({ code, jt, jf, k });
	stmt(LD_ABS_W, 4); // seccomp_data.arch
	stmt(JEQ_K, ARCH.audit, 1, 0);
	stmt(RET_K, KILL_PROCESS);
	stmt(LD_ABS_W, 0); // seccomp_data.nr
	if (ARCH.x32Bit) {
		stmt(JGE_K, ARCH.x32Bit, 0, 1);
		stmt(RET_K, fail(EPERM));
	}
	for (const nr of SYS.ioUring) {
		stmt(JEQ_K, nr, 0, 1);
		stmt(RET_K, fail(ENOSYS));
	}
	for (const nr of denied) {
		stmt(JEQ_K, nr, 0, 1);
		stmt(RET_K, fail(EPERM));
	}
	stmt(JEQ_K, ARCH.socket, 1, 0);
	stmt(RET_K, ALLOW);
	stmt(LD_ABS_W, 16); // low half of args[0], the address family
	stmt(JEQ_K, AF_UNIX, 0, 1);
	stmt(RET_K, fail(EACCES));
	stmt(RET_K, ALLOW);

	const filter = Buffer.alloc(prog.length * 8);
	prog.forEach((s, i) => {
		filter.writeUInt16LE(s.code, i * 8);
		filter.writeUInt8(s.jt, i * 8 + 2);
		filter.writeUInt8(s.jf, i * 8 + 3);
		filter.writeUInt32LE(s.k >>> 0, i * 8 + 4);
	});
	// struct sock_fprog: u16 length, padding, pointer.
	const fprog = new BigUint64Array([BigInt(prog.length), BigInt(ptr(filter))]);
	sys(ARCH.prctl, PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ptr(fprog));
}

/** A plan that reads as confined but leaves these reachable is not confinement. */
function checkForbidden() {
	for (const path of spec.forbidden) {
		try {
			if (statSync(path).isDirectory()) readdirSync(path);
			else readFileSync(path).subarray(0, 1);
		} catch (e) {
			if (e.code === 'EACCES' || e.code === 'ENOENT' || e.code === 'EPERM') continue;
			throw e;
		}
		throw new Error(`the plugin could still read ${path}`);
	}
}

function execPlugin(binaryFd) {
	const args = spec.argv.map(cstr);
	const { OPAL_SANDBOX_SPEC: _spec, ...env } = process.env;
	const vars = Object.entries({ ...env, ...spec.env }).map(([k, v]) => cstr(`${k}=${v}`));
	const pointers = (list) => new BigUint64Array([...list.map((b) => BigInt(ptr(b))), 0n]);
	const argv = pointers(args);
	const envp = pointers(vars);
	// Anything the server left open stays behind: a file descriptor passes any path check.
	sys(SYS.closeRange, 3, 0xffffffff, CLOSE_RANGE_CLOEXEC);
	const empty = cstr('');
	sys(ARCH.execveat, binaryFd, ptr(empty), ptr(argv), ptr(envp), AT_EMPTY_PATH);
}

try {
	// Before the user change: the plugin's user may not be able to walk to the binary.
	const binaryFd = spec.probe ? -1 : openSync(spec.exec, O_PATH | O_CLOEXEC);
	if (spec.uid !== undefined) dropUser(spec.uid, spec.gid);
	sys(ARCH.prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
	let abi = 0;
	try {
		abi = landlock();
	} catch (e) {
		// With a second user, a kernel without Landlock leaves the user change and the filter. Any
		// other failure, or no second user, stops here.
		if (spec.uid === undefined || e.kind !== 'no-landlock') throw e;
	}
	seccomp(abi);
	checkForbidden();
	// Its own folders must be reachable from here. Under a second user, a closed parent folder stops it.
	readdirSync(spec.cwd);
	// The server made it. This only checks that the plugin can use it.
	if (!statSync(spec.tmp).isDirectory()) throw new Error(`${spec.tmp} is not a folder`);
	if (spec.probe) {
		console.log(JSON.stringify({ ok: true, abi }));
		process.exit(0);
	}
	process.chdir(spec.cwd);
	execPlugin(binaryFd);
} catch (e) {
	const reason = e instanceof Error ? e.message : String(e);
	if (spec.probe) console.log(JSON.stringify({ ok: false, kind: e?.kind, reason }));
	else console.error(`opal: plugin not started, confinement failed: ${reason}`);
	process.exit(126);
}
