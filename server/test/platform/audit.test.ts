import { describe, expect, test } from 'bun:test';
import type { Ctx } from '../../src/context.ts';
import { auditLog, part } from '../../src/db/schema/index.ts';
import { insert, remove, update } from '../../src/write.ts';
import { registerEntity } from '../../src/services/platform/entities.ts';
import { setup } from './helpers.ts';

const newPart = { internalPn: 'P-1', name: 'Bolt', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 1 } as const;

type S = Awaited<ReturnType<typeof setup>>;
const ctx = (s: S, i: number, op = 'test.write'): Ctx => ({
	db: s.db,
	op,
	actor: { kind: 'user', userId: s.users[i]!.id, isAdmin: false, sessionId: 1 }
});

describe('audit log', () => {
	test('entries resolve to the record name and page, never an id', async () => {
		const s = await setup();
		insert(ctx(s, 0), part, newPart);
		const res = await (await s.call('GET', '/audit')).json();
		const e = res.items[0];
		expect(e).toMatchObject({ action: 'create', entity: 'part', entityLabel: 'Part', recordLabel: 'P-1', href: expect.stringMatching(/^\/parts\/\d+$/), userName: 'User 1' });
		expect(res.total).toBe(1);
	});

	test('an update lists only the fields that changed, not updatedAt', async () => {
		const s = await setup();
		const p = insert(ctx(s, 0), part, newPart);
		update(ctx(s, 0), part, p.id, { name: 'Nut' });
		const [e] = (await (await s.call('GET', '/audit?action=update')).json()).items;
		expect(e.changes.map((c: { field: string }) => c.field)).toEqual(['name']);
		expect(e.changes[0]).toMatchObject({ old: 'Bolt', new: 'Nut' });
	});

	test('user foreign keys carry the person name as a label', async () => {
		const s = await setup();
		const p = insert(ctx(s, 0), part, newPart);
		update(ctx(s, 0), part, p.id, { activatedById: s.users[1]!.id });
		const [e] = (await (await s.call('GET', '/audit?action=update')).json()).items;
		expect(e.changes[0]).toMatchObject({ field: 'activatedById', newLabel: 'User 2' });
	});

	test('filters by record, action, user and date range', async () => {
		const s = await setup();
		const a = insert(ctx(s, 0), part, newPart);
		const b = insert(ctx(s, 1), part, { ...newPart, internalPn: 'P-2' });
		update(ctx(s, 1), part, b.id, { name: 'X' });
		const get = async (q: string) => (await (await s.call('GET', `/audit?${q}`)).json()).items;
		expect(await get(`entity=part&entityId=${a.id}`)).toHaveLength(1);
		expect(await get('action=update')).toHaveLength(1);
		expect(await get(`userId=${s.users[1]!.id}`)).toHaveLength(2);
		const today = new Date().toISOString().slice(0, 10);
		expect(await get(`from=${today}&to=${today}`)).toHaveLength(3);
		expect(await get('to=2000-01-01')).toHaveLength(0);
		expect(await get('from=2999-01-01')).toHaveLength(0);
		expect((await s.call('GET', '/audit?from=nonsense')).status).toBe(422);
	});

	test('pages by cursor and by offset, newest first', async () => {
		const s = await setup();
		for (let i = 0; i < 5; i++) insert(ctx(s, 0), part, { ...newPart, internalPn: `P-${i}` });
		const p1 = await (await s.call('GET', '/audit?limit=2')).json();
		expect(p1.items.map((e: { recordLabel: string }) => e.recordLabel)).toEqual(['P-4', 'P-3']);
		const p2 = await (await s.call('GET', `/audit?limit=2&cursor=${p1.next}`)).json();
		expect(p2.items.map((e: { recordLabel: string }) => e.recordLabel)).toEqual(['P-2', 'P-1']);
		const off = await (await s.call('GET', '/audit?limit=2&offset=4')).json();
		expect(off.items.map((e: { recordLabel: string }) => e.recordLabel)).toEqual(['P-0']);
		expect(off.total).toBe(5);
	});

	test('a deleted record still resolves from its last snapshot', async () => {
		const s = await setup();
		const p = insert(ctx(s, 0), part, newPart);
		remove(ctx(s, 0), part, p.id);
		const [e] = (await (await s.call('GET', '/audit?action=delete')).json()).items;
		expect(e.recordLabel).toBe('P-1');
	});

	test('a child table resolves to its parent through the registry', async () => {
		const s = await setup();
		const { attachment } = await import('../../src/db/schema/index.ts');
		registerEntity(attachment, { label: 'Attachment', parent: { table: part, fk: 'ownerId' } });
		const p = insert(ctx(s, 0), part, newPart);
		const { blob } = await import('../../src/db/schema/index.ts');
		s.db.insert(blob).values({ sha256: 'a'.repeat(64), sizeBytes: 1, mimeType: 'text/plain', createdAt: 'x' }).run();
		insert(ctx(s, 0), attachment, { blobSha256: 'a'.repeat(64), filename: 'f', ownerType: 'part', ownerId: p.id });
		const [e] = (await (await s.call('GET', '/audit?entity=attachment')).json()).items;
		expect(e).toMatchObject({ entityLabel: 'Attachment', recordLabel: 'P-1' });
	});

	test('history lists every change to one record', async () => {
		const s = await setup();
		const p = insert(ctx(s, 0), part, newPart);
		insert(ctx(s, 0), part, { ...newPart, internalPn: 'P-2' });
		update(ctx(s, 0), part, p.id, { name: 'Nut' });
		const h = await (await s.call('GET', `/audit/history/part/${p.id}`)).json();
		expect(h.items.map((e: { action: string }) => e.action)).toEqual(['update', 'create']);
	});

	test('facets list the entity types in the log and the users who wrote entries', async () => {
		const s = await setup();
		insert(ctx(s, 1), part, newPart);
		const f = await (await s.call('GET', '/audit/facets')).json();
		expect(f.entities).toEqual([{ value: 'part', label: 'Part' }]);
		expect(f.users).toEqual([{ id: s.users[1]!.id, name: 'User 2' }]);
	});

	test('secrets never reach the log', async () => {
		const s = await setup();
		const { user } = await import('../../src/db/schema/index.ts');
		insert(ctx(s, 0), user, { username: 'x', name: 'X', passwordHash: 'secret' });
		const row = s.db.select().from(auditLog).all().at(-1)!;
		expect(JSON.stringify(row.after)).not.toContain('secret');
	});

	test('anonymous callers get 401', async () => {
		const s = await setup();
		s.setActor({ kind: 'anonymous' });
		expect((await s.call('GET', '/audit')).status).toBe(401);
	});
});
