// Test plugin: tries what a plugin should and should not be able to do, and reports the outcome.
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync
} from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

const own = process.env.OPAL_PLUGIN_DATA;
const root = join(own, '..', '..');
const VERSION = readFileSync(new URL('./version.txt', import.meta.url), 'utf8').trim();

const attempt = (fn) => {
	try {
		return { ok: true, value: fn() };
	} catch (e) {
		return { ok: false, code: e.code ?? e.message };
	}
};
const api = async (path) => (await fetch(`${process.env.OPAL_URL}/api${path}`, { headers: { authorization: `Bearer ${process.env.OPAL_TOKEN}` } })).status;
const unixSocket = (path) =>
	new Promise((resolve) => {
		const s = connect(path);
		s.on('connect', () => {
			s.destroy();
			resolve({ ok: true });
		});
		s.on('error', (e) => resolve({ ok: false, code: e.code }));
	});

function outside(q) {
	const db = join(root, 'opal.db');
	const code = new URL('.', import.meta.url).pathname;
	const server = process.ppid;
	// Under a user of its own the plugin cannot even list these, which also counts as refused.
	const fds = attempt(() => readdirSync(`/proc/${server}/fd`));
	return {
		db: attempt(() => readFileSync(db).subarray(0, 15).toString()),
		dbWal: attempt(() => readFileSync(`${db}-wal`).length),
		dbWrite: attempt(() => writeFileSync(db, 'overwritten')),
		secret: attempt(() => readFileSync(join(root, '.opal_auth_secret'), 'utf8')),
		secretsKey: attempt(() => readFileSync(join(root, '.opal_secrets_key'), 'utf8')),
		secretsKeyTmp: attempt(() => readFileSync(join(root, '.opal_secrets_key.tmp'), 'utf8')),
		dataFolder: attempt(() => readdirSync(root)),
		rename: attempt(() => renameSync(db, join(own, 'stolen.db'))),
		symlink: attempt(() => {
			rmSync(join(own, 'link'), { force: true });
			symlinkSync(db, join(own, 'link'));
			return readFileSync(join(own, 'link')).subarray(0, 15).toString();
		}),
		hardlink: attempt(() => {
			rmSync(join(own, 'hard'), { force: true });
			linkSync(db, join(own, 'hard'));
			return readFileSync(join(own, 'hard')).subarray(0, 15).toString();
		}),
		chmod: attempt(() => chmodSync(db, 0o666)),
		truncate: attempt(() => truncateSync(db, 0)),
		sibling: attempt(() => readFileSync(join(root, 'plugin-data', 'other', 'note.txt'), 'utf8')),
		siblingWrite: attempt(() => writeFileSync(join(root, 'plugin-data', 'other', 'note.txt'), 'x')),
		codeWrite: attempt(() => writeFileSync(join(code, 'written.txt'), 'x')),
		tmp: attempt(() => writeFileSync(`/tmp/opal-reach-${process.pid}`, 'x')),
		home: attempt(() => readdirSync(q.get('home'))),
		etcShadow: attempt(() => readFileSync('/etc/shadow').length),
		serverEnviron: attempt(() => readFileSync(`/proc/${server}/environ`).length),
		serverMem: attempt(() => readFileSync(`/proc/${server}/mem`).length),
		serverCwd: attempt(() => readdirSync(`/proc/${server}/cwd/`)),
		serverRoot: attempt(() => readdirSync(`/proc/${server}/root${root}`)),
		serverFds: fds.ok ? fds.value.map((fd) => attempt(() => readlinkSync(`/proc/${server}/fd/${fd}`))) : [fds]
	};
}

function inside() {
	const file = join(own, 'mine', 'state.txt');
	return {
		// Its own files, and renaming within them.
		write: attempt(() => {
			mkdirSync(join(own, 'mine'), { recursive: true });
			writeFileSync(file, 'kept');
			renameSync(file, `${file}.new`);
			renameSync(`${file}.new`, file);
			return readFileSync(file, 'utf8');
		}),
		temp: attempt(() => {
			writeFileSync(join(process.env.TMPDIR, 'scratch'), 'x');
			return process.env.TMPDIR;
		}),
		home: process.env.HOME,
		code: attempt(() => readFileSync(new URL('./opal-plugin.json', import.meta.url), 'utf8').length),
		openFiles: readdirSync('/proc/self/fd').flatMap((fd) => {
			const target = attempt(() => readlinkSync(`/proc/self/fd/${fd}`));
			return target.ok ? [target.value] : [];
		}),
		child: attempt(() => spawnSync('/usr/bin/env', ['echo', 'from a child']).stdout.toString().trim()),
		bunChild: attempt(() => {
			const r = spawnSync(process.execPath, ['-e', 'console.log(1 + 1)'], { env: process.env });
			return r.stdout.toString().trim();
		})
	};
}

Bun.serve({
	port: Number(process.env.OPAL_PLUGIN_PORT),
	hostname: '127.0.0.1',
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === '/__health') return new Response('ok');
		if (url.pathname === '/version') return Response.json({ version: VERSION, mine: attempt(() => readFileSync(join(own, 'mine', 'state.txt'), 'utf8')) });
		if (url.pathname === '/keep') {
			mkdirSync(join(own, 'mine'), { recursive: true });
			writeFileSync(join(own, 'mine', 'state.txt'), url.searchParams.get('text'));
			return Response.json({ ok: true });
		}
		if (url.pathname === '/inside') return Response.json(inside());
		if (url.pathname === '/outside') return Response.json(outside(url.searchParams));
		if (url.pathname === '/socket') return Response.json(await unixSocket(url.searchParams.get('path')));
		if (url.pathname === '/api') return Response.json({ status: await api(url.searchParams.get('path')) });
		if (url.pathname === '/uid') return Response.json({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() });
		if (url.pathname === '/crash') {
			setTimeout(() => process.exit(3), 10);
			return Response.json({ ok: true });
		}
		return new Response('not found', { status: 404 });
	}
});
