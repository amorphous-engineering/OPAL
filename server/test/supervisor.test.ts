import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor, defaultChildCommand } from '../src/supervisor/supervisor.ts';
import { hasDisplay, openCommand } from '../src/supervisor/browser.ts';
import { assetName } from '../src/supervisor/updater.ts';
import { VERSION } from '../src/version.ts';
import { mockGithub } from './updater-mock.ts';

const FAKE = join(import.meta.dir, 'supervisor-fake-child.ts');
const live: Supervisor[] = [];
afterEach(async () => {
	for (const s of live.splice(0)) {
		await s.child.stop();
		s.control.stop();
	}
});

const randPort = () => 20000 + Math.floor(Math.random() * 30000);

function make(extra: string[] = [], over: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
	const childPort = randPort();
	const sup = new Supervisor({
		controlPort: 0,
		childPort,
		childCommand: () => [process.execPath, FAKE, String(childPort), ...extra],
		dataDir: '/data/here',
		compiled: false,
		child: { healthPollMs: 50, killAfterMs: 1000 },
		exit: () => {},
		...over
	});
	live.push(sup);
	return { sup, childPort };
}

const call = (sup: Supervisor, path: string, init: RequestInit = {}) =>
	fetch(`${sup.control.origin}/api/${path}`, {
		...init,
		headers: { 'x-opal-key': sup.control.secret, ...(init.headers as object) }
	});

async function until(cond: () => boolean, ms = 8000) {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await Bun.sleep(25);
	expect(cond()).toBe(true);
}

describe('version', () => {
	test('defaults to the dev version', () => expect(VERSION).toBe('0.0.0-dev'));
});

describe('child command', () => {
	test('compiled re-runs the binary; dev runs cli.ts under bun', () => {
		expect(defaultChildCommand(['--port', '1'], true)).toEqual([process.execPath, 'serve', '--port', '1']);
		const dev = defaultChildCommand(['--port', '1'], false);
		expect(dev[1]).toMatch(/src\/cli\.ts$/);
		expect(dev.slice(2)).toEqual(['serve', '--port', '1']);
	});
	test('browser commands per platform', () => {
		expect(openCommand('u', 'darwin')[0]).toBe('open');
		expect(openCommand('u', 'linux')[0]).toBe('xdg-open');
		expect(openCommand('u', 'win32').slice(0, 3)).toEqual(['cmd', '/c', 'start']);
		expect(hasDisplay('linux', {})).toBe(false);
		expect(hasDisplay('linux', { DISPLAY: ':0' })).toBe(true);
	});
});

describe('lifecycle', () => {
	test('start, running, logs, stop', async () => {
		const { sup } = make();
		expect(sup.child.state).toBe('stopped');
		sup.child.start();
		expect(sup.child.state).toBe('starting');
		await until(() => sup.child.state === 'running');
		await until(() => sup.child.log().some((l) => l.includes('fake child stderr')));
		expect(sup.child.log().some((l) => l.includes('listening'))).toBe(true);
		const pid = sup.child.pid!;
		await sup.child.stop();
		expect(sup.child.state).toBe('stopped');
		expect(() => process.kill(pid, 0)).toThrow();
	});
	test('crash is detected', async () => {
		const { sup } = make(['--crash-after', '300']);
		sup.child.start();
		await until(() => sup.child.state === 'running');
		await until(() => sup.child.state === 'crashed');
		expect(sup.child.exitCode).toBe(7);
		expect(sup.child.log().some((l) => l.includes('exited with code 7'))).toBe(true);
	});
	test('a child that never answers health ends crashed', async () => {
		const { sup } = make([], {
			childCommand: () => [process.execPath, '-e', 'setInterval(()=>{},1000)'],
			child: { healthPollMs: 30, healthTimeoutMs: 300, killAfterMs: 500 }
		});
		sup.child.start();
		await until(() => sup.child.state === 'crashed');
		await Bun.sleep(100);
		expect(sup.child.state).toBe('crashed');
	});
	test('ring buffer keeps the last lines', async () => {
		const { sup } = make([], {
			childCommand: () => [process.execPath, '-e', 'for(let i=0;i<700;i++)console.log("line "+i)'],
			child: { maxLines: 500, healthTimeoutMs: 200, healthPollMs: 30 }
		});
		sup.child.start();
		await until(() => sup.child.log().some((l) => l === 'line 699'));
		const lines = sup.child.log();
		expect(lines.length).toBeLessThanOrEqual(500);
		expect(lines.includes('line 0')).toBe(false);
	});
});

describe('control API', () => {
	test('rejects a missing or wrong secret', async () => {
		const { sup } = make();
		const bare = await fetch(`${sup.control.origin}/api/status`);
		expect(bare.status).toBe(401);
		const wrong = await fetch(`${sup.control.origin}/api/status`, { headers: { 'x-opal-key': 'nope' } });
		expect(wrong.status).toBe(401);
		const post = await fetch(`${sup.control.origin}/api/start`, { method: 'POST' });
		expect(post.status).toBe(401);
		expect(sup.child.state).toBe('stopped');
	});
	test('rejects a foreign Origin even with the secret', async () => {
		const { sup } = make();
		const res = await call(sup, 'start', { method: 'POST', headers: { origin: 'https://evil.example' } });
		expect(res.status).toBe(403);
		expect(sup.child.state).toBe('stopped');
		const pre = await fetch(`${sup.control.origin}/api/start`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
		expect(pre.status).toBe(403);
	});
	test('rejects a foreign Host header', async () => {
		const { sup } = make();
		const res = await call(sup, 'status', { headers: { host: 'evil.example' } });
		expect(res.status).toBe(403);
	});
	test('own Origin with secret works; status has the fields; page is served', async () => {
		const { sup, childPort } = make();
		const res = await call(sup, 'start', { method: 'POST', headers: { origin: sup.control.origin } });
		expect(res.status).toBe(200);
		await until(() => sup.child.state === 'running');
		const st = await (await call(sup, 'status')).json();
		expect(st).toMatchObject({ state: 'running', port: childPort, dataDir: '/data/here', version: VERSION });
		expect(st.url).toBe(`http://127.0.0.1:${childPort}`);
		expect(Array.isArray(st.log)).toBe(true);
		const page = await fetch(sup.control.url);
		expect(page.status).toBe(200);
		const html = await page.text();
		for (const label of ['Start', 'Stop', 'Restart', 'Open OPAL', 'Check for update', 'Update', 'Quit']) {
			expect(html).toContain(`>${label}</button>`);
		}
		expect(html).not.toMatch(/https?:\/\/(?!127)/);
		await call(sup, 'stop', { method: 'POST' });
		expect(sup.child.state).toBe('stopped');
	});
	test('quit stops the child and exits', async () => {
		let code: number | null = null;
		const { sup } = make([], { exit: (c) => (code = c) });
		sup.child.start();
		await until(() => sup.child.state === 'running');
		await call(sup, 'quit', { method: 'POST' });
		await until(() => code === 0);
		expect(sup.child.state).toBe('stopped');
	});
	test('update in a dev run is refused with a clear message', async () => {
		const { sup } = make();
		const r = await (await call(sup, 'update', { method: 'POST' })).json();
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/compiled/);
	});
});

describe('update through the supervisor', () => {
	function setup(binary: string, sums?: 'bad') {
		const dir = mkdtempSync(join(tmpdir(), 'opal-sup-'));
		const bin = join(dir, 'opal');
		writeFileSync(bin, 'OLD');
		chmodSync(bin, 0o755);
		const gh = mockGithub({ tag: 'v2.0.0', binary, platform: process.platform, arch: process.arch, sums });
		const { sup } = make([], {
			compiled: true,
			version: '1.0.0',
			binaryPath: bin,
			updateHealthMs: 3000,
			updater: { apiUrl: gh.apiUrl, platform: process.platform, arch: process.arch, log: () => {} },
			childCommand: () => [process.execPath, FAKE, String(live[live.length - 1]!.child.port), '--bad-if-file', bin]
		});
		return { dir, bin, sup };
	}

	test('check finds the release, update swaps and restarts the child', async () => {
		try { assetName(); } catch { return; }
		const { bin, sup } = setup('NEW');
		sup.child.start();
		await until(() => sup.child.state === 'running');
		const c = await (await call(sup, 'check', { method: 'POST' })).json();
		expect(c.message).toContain('2.0.0');
		const u = await (await call(sup, 'update', { method: 'POST' })).json();
		expect(u.ok).toBe(true);
		expect(readFileSync(bin, 'utf8')).toBe('NEW');
		expect(sup.child.state).toBe('running');
	});

	test('unhealthy new binary is rolled back', async () => {
		try { assetName(); } catch { return; }
		const { bin, sup } = setup('BAD');
		sup.child.start();
		await until(() => sup.child.state === 'running');
		const u = await (await call(sup, 'update', { method: 'POST' })).json();
		expect(u.ok).toBe(false);
		expect(u.message).toMatch(/restored/);
		expect(readFileSync(bin, 'utf8')).toBe('OLD');
		await until(() => sup.child.state === 'running');
	});

	test('bad checksum leaves the binary alone', async () => {
		try { assetName(); } catch { return; }
		const { bin, sup } = setup('NEW', 'bad');
		const u = await (await call(sup, 'update', { method: 'POST' })).json();
		expect(u.ok).toBe(false);
		expect(u.message).toMatch(/mismatch/);
		expect(readFileSync(bin, 'utf8')).toBe('OLD');
		expect(existsSync(`${bin}.new`)).toBe(false);
	});
});
