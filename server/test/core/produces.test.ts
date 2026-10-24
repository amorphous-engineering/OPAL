import { expect, test } from 'bun:test';
import { op } from '@opal/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponse, implement, mountOps } from '../../src/registry.ts';
import { openTestDb } from '../helpers/db.ts';

test('a produces contract returns its body with the declared content type and file name', async () => {
	const db = await openTestDb();
	const csv = op({
		name: 'test.csv',
		method: 'GET',
		path: '/test.csv',
		summary: 'CSV',
		input: z.object({}),
		output: z.string(),
		access: 'public',
		mcp: false,
		produces: 'text/csv',
		filename: 'test.csv'
	});
	const app = new Hono();
	mountOps(app, [implement(csv, () => 'a,b\n1,2\n')], db, () => ({ kind: 'anonymous' }));
	const res = await app.request('/api/test.csv');
	expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
	expect(res.headers.get('content-disposition')).toBe('attachment; filename="test.csv"');
	expect(await res.text()).toBe('a,b\n1,2\n');
});

test('a POST with a JSON content type and an empty body is treated as no input', async () => {
	const db = await openTestDb();
	const ping = op({
		name: 'test.ping',
		method: 'POST',
		path: '/test/ping',
		summary: 'Ping',
		input: z.object({}),
		output: z.object({ ok: z.literal(true) }),
		access: 'public',
		mcp: false
	});
	const app = new Hono();
	app.onError((err, c) => {
		const { status, body } = errorResponse(err);
		return c.json(body, status as 400);
	});
	mountOps(app, [implement(ping, () => ({ ok: true as const }))], db, () => ({ kind: 'anonymous' }));
	const res = await app.request('/api/test/ping', { method: 'POST', headers: { 'content-type': 'application/json' } });
	expect(res.status).toBe(200);
	const bad = await app.request('/api/test/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
	expect(bad.status).toBe(400);
});
