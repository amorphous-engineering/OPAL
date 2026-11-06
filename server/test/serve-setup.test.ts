import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'opal-serve-setup-'));
const port = 19700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'src/cli.ts', 'serve', '--port', String(port), '--host', '127.0.0.1'], {
	cwd: join(import.meta.dir, '..'),
	env: { ...process.env, OPAL_DATA_DIR: dir, OPAL_PLUGINS: '0' },
	stdout: 'pipe',
	stderr: 'ignore'
});

afterAll(() => {
	server.kill();
	rmSync(dir, { recursive: true, force: true });
});

const setup = (body: object) =>
	fetch(`${base}/api/auth/setup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: 'first', name: 'First', password: 'first-password-1', ...body })
	});

/** Every other test drives the app directly. Only a real start proves `serve` asks for the code. */
describe('opal serve on an empty database', () => {
	test('it prints a setup code and refuses setup without it', async () => {
		let up = false;
		for (let i = 0; i < 120 && !up; i++) {
			up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
			if (!up) await Bun.sleep(250);
		}
		expect(up).toBe(true);
		const config = (await (await fetch(`${base}/api/auth/config`)).json()) as { setupCodeRequired: boolean };
		expect(config.setupCodeRequired).toBe(true);
		expect((await setup({})).status).toBe(403);
		let printed = '';
		const reader = server.stdout.getReader();
		while (!/[A-Z2-9]{4}-[A-Z2-9]{4}/.test(printed)) {
			const { value, done } = await reader.read();
			if (done) break;
			printed += new TextDecoder().decode(value);
		}
		const code = /[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(printed)![0];
		expect((await setup({ setupCode: code })).status).toBe(200);
	}, 120_000);
});
