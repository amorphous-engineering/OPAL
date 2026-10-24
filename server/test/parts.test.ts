import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.ts';
import type { Actor } from '../src/context.ts';
import { openDb } from '../src/db/client.ts';
import { auditLog } from '../src/db/schema.ts';

function setup(actor: Actor = { kind: 'system' }) {
	const db = openDb(':memory:');
	const app = createApp({ db, resolveActor: () => actor });
	const call = (method: string, path: string, body?: unknown) =>
		app.request(`/api${path}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
	return { db, call };
}

describe('parts', () => {
	test('create assigns a part number, stores the quantity exactly, writes an audit row', async () => {
		const { db, call } = setup();
		const res = await call('POST', '/parts', { name: 'Bolt', tier: 1, reorderPoint: '0.1234' });
		expect(res.status).toBe(201);
		const part = await res.json();
		expect(part.internalPn).toBe('P-00001');
		expect(part.reorderPoint).toBe('0.1234');
		expect(part.state).toBe('draft');
		const rows = db.select().from(auditLog).all();
		expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
		expect(rows.every((r) => r.op === 'parts.create')).toBe(true);
	});

	test('invalid input returns 422 with fields', async () => {
		const { call } = setup();
		const res = await call('POST', '/parts', { tier: 0 });
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error).toBe('invalid_input');
		expect(Object.keys(body.fields)).toEqual(expect.arrayContaining(['name', 'tier']));
	});

	test('anonymous callers get 401', async () => {
		const { call } = setup({ kind: 'anonymous' });
		expect((await call('GET', '/parts')).status).toBe(401);
	});

	test('list paginates with a cursor', async () => {
		const { call } = setup();
		for (const name of ['A', 'B', 'C']) await call('POST', '/parts', { name, tier: 1 });
		const first = await (await call('GET', '/parts?limit=2')).json();
		expect(first.items.map((p: { name: string }) => p.name)).toEqual(['C', 'B']);
		const second = await (await call('GET', `/parts?limit=2&cursor=${first.next}`)).json();
		expect(second.items.map((p: { name: string }) => p.name)).toEqual(['A']);
		expect(second.next).toBeNull();
	});

	test('a failed write rolls back', async () => {
		const { db, call } = setup();
		await call('POST', '/parts', { name: 'A', tier: 1, internalPn: 'X-1' });
		const res = await call('POST', '/parts', { name: 'B', tier: 1, internalPn: 'X-1' });
		expect(res.status).toBe(409);
		expect(db.select().from(auditLog).all()).toHaveLength(1);
	});
});
