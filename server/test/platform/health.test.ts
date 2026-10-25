import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync } from 'node:fs';
import { blobDir } from '../../src/services/platform/attachments.ts';
import { health } from '../../src/services/platform/health.ts';
import { setup } from './helpers.ts';

describe('health', () => {
	test('a healthy server reports ok with every check, and needs no sign-in', async () => {
		const s = await setup();
		s.setActor({ kind: 'anonymous' });
		const res = await s.call('GET', '/health');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe('ok');
		expect(body.checks.map((c: { name: string }) => c.name)).toEqual(['database', 'storage', 'disk']);
		expect(body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
	});

	test('low free disk space is degraded, not down', async () => {
		const s = await setup();
		const h = health(s.db, Number.MAX_SAFE_INTEGER);
		expect(h.status).toBe('degraded');
		expect(h.checks.find((c) => c.name === 'disk')).toMatchObject({
			ok: false
		});
	});

	test('a file store the server cannot write is degraded', async () => {
		const s = await setup();
		mkdirSync(blobDir(), { recursive: true });
		chmodSync(blobDir(), 0o500);
		try {
			const h = health(s.db);
			expect(h.status).toBe('degraded');
			expect(h.checks.find((c) => c.name === 'storage')).toMatchObject({
				ok: false
			});
		} finally {
			chmodSync(blobDir(), 0o700);
		}
	});

	test('a database that cannot answer is down', async () => {
		const s = await setup();
		s.db.$client.close();
		const h = health(s.db);
		expect(h.status).toBe('down');
		expect(h.checks[0]).toMatchObject({ name: 'database', ok: false });
	});

	test('details never name a file path', async () => {
		const s = await setup();
		for (const c of health(s.db, Number.MAX_SAFE_INTEGER).checks) expect(c.detail ?? '').not.toContain('/');
	});
});
