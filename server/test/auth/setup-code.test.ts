import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createApp } from '../../src/app.ts';
import { armSetupCode, disarmSetupCode, reissueSetupCode } from '../../src/services/auth/setup-code.ts';
import { openTestDb } from '../helpers/db.ts';

const BODY = { username: 'first', name: 'First Admin', password: 'first-password-1' };
const IP = 'http://192.168.1.20:8080';

async function app() {
	const a = createApp({ db: await openTestDb() });
	const post = (origin: string, body: object) =>
		a.request(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const config = async (origin: string) => (await (await a.request(`${origin}/api/auth/config`)).json()) as any;
	return { post, config };
}

/** Arms setup and returns the code it printed. */
function armed(): string {
	const log = spyOn(console, 'log').mockImplementation(() => {});
	armSetupCode(true, 'http://localhost:8080');
	const printed = String(log.mock.calls.at(-1)?.[0]);
	log.mockRestore();
	return /[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(printed)![0];
}

afterEach(() => {
	disarmSetupCode();
	delete process.env.OPAL_ALLOWED_HOSTS;
});

describe('first-run setup', () => {
	test('it takes the code the server printed, and refuses without it', async () => {
		const { post, config } = await app();
		const code = armed();
		expect((await config(IP)).setupCodeRequired).toBe(true);
		expect((await post(IP, BODY)).status).toBe(403);
		expect((await post(IP, { ...BODY, setupCode: 'AAAA-AAAA' })).status).toBe(403);
		expect((await config(IP)).needsSetup).toBe(true);
		expect((await post(IP, { ...BODY, setupCode: code.toLowerCase() })).status).toBe(200);
		expect((await config(IP)).needsSetup).toBe(false);
	});

	test('a run of wrong guesses replaces the code', async () => {
		const { post } = await app();
		const code = armed();
		const log = spyOn(console, 'log').mockImplementation(() => {});
		for (let i = 0; i < 20; i++) await post(IP, { ...BODY, setupCode: 'AAAA-AAAA' });
		log.mockRestore();
		expect((await post(IP, { ...BODY, setupCode: code })).status).toBe(403);
	});

	test('a host name nobody listed is refused even with the code, since a web page can choose its own name', async () => {
		const { post, config } = await app();
		const code = armed();
		expect((await config('http://evil.example')).setupHostAllowed).toBe(false);
		expect((await post('http://evil.example', { ...BODY, setupCode: code })).status).toBe(403);
	});

	test('an IP address, a loopback name and a listed name are all fine', async () => {
		for (const origin of ['http://192.168.1.20:8080', 'http://[fd00::1]:8080', 'http://localhost:8080', 'http://127.0.0.1:8080']) {
			expect((await (await app()).config(origin)).setupHostAllowed).toBe(true);
		}
		armed();
		process.env.OPAL_ALLOWED_HOSTS = 'opal.lan';
		expect((await (await app()).config('http://opal.lan:8080')).setupHostAllowed).toBe(true);
	});

	test('going back to first run prints a new code', () => {
		const code = armed();
		const log = spyOn(console, 'log').mockImplementation(() => {});
		reissueSetupCode();
		const printed = String(log.mock.calls.at(-1)?.[0]);
		log.mockRestore();
		expect(printed).toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
		expect(printed).not.toContain(code);
	});
});
