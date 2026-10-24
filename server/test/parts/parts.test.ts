import { describe, expect, test } from 'bun:test';
import { auditLog } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

describe('part create', () => {
	test('a part is born draft with a generated number, an exact quantity and an audit row', async () => {
		const { db, api } = await setup();
		const res = await api('POST', '/parts', { name: 'Bolt', tier: 1, reorderPoint: '0.1234' });
		expect(res.status).toBe(201);
		expect(res.json.internalPn).toBe('PN-1-0001');
		expect(res.json.reorderPoint).toBe('0.1234');
		expect(res.json.state).toBe('draft');
		const rows = db.select().from(auditLog).all();
		expect(rows.filter((r) => r.entity === 'part').map((r) => r.action)).toEqual(['create']);
		expect(rows.every((r) => r.op === 'parts.create')).toBe(true);
	});

	test('invalid input returns 422 with the failing fields', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts', { tier: 0 });
		expect(res.status).toBe(422);
		expect(res.json.error).toBe('invalid_input');
		expect(Object.keys(res.json.fields)).toEqual(expect.arrayContaining(['name', 'tier']));
	});

	test('anonymous callers get 401', async () => {
		const { call } = await setup();
		expect((await call(null, 'GET', '/parts')).status).toBe(401);
	});

	test('a reorder point cannot be negative', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts', { name: 'X', tier: 1, reorderPoint: '-1' });
		expect(res.status).toBe(422);
		expect(res.json.fields.reorderPoint).toBeDefined();
	});

	test('is_tooling is honoured on every tier', async () => {
		const { create } = await setup();
		for (const tier of [1, 2, 3]) {
			const p = await create({ name: `Tool ${tier}`, tier, isTooling: true, calibrationIntervalDays: 365 });
			expect(p.isTooling).toBe(true);
			expect(p.calibrationIntervalDays).toBe(365);
		}
	});

	test('procurement defaults to buy when an external PN is given, else make', async () => {
		const { create } = await setup();
		expect((await create({ name: 'A', externalPn: 'MCM-1' })).procurement).toBe('buy');
		expect((await create({ name: 'B' })).procurement).toBe('make');
		expect((await create({ name: 'C', externalPn: 'MCM-2', procurement: 'both' })).procurement).toBe('both');
	});

	test('tracking defaults to the tier default: serialized on tiers 1 and 2, bulk on 3', async () => {
		const { create } = await setup();
		expect((await create({ name: 'A', tier: 1 })).trackingType).toBe('serialized');
		expect((await create({ name: 'B', tier: 3 })).trackingType).toBe('bulk');
		expect((await create({ name: 'C', tier: 3, trackingType: 'serialized' })).trackingType).toBe('serialized');
	});

	test('a configured project limits tiers and sets the tracking default', async () => {
		const { api, configureProject } = await setup();
		configureProject({
			tiers: [{ level: 1, name: 'Flight', code: 'F', default_tracking: 'bulk' }],
			part_numbering: { prefix: 'OP', separator: '/', sequence_digits: 3, format: '{prefix}{sep}{tier_code}{sep}{sequence}' }
		});
		const ok = await api('POST', '/parts', { name: 'A', tier: 1 });
		expect(ok.json.internalPn).toBe('OP/F/001');
		expect(ok.json.trackingType).toBe('bulk');
		expect(ok.json.tierName).toBe('Flight');
		const bad = await api('POST', '/parts', { name: 'B', tier: 7 });
		expect(bad.status).toBe(422);
		expect(bad.json.fields.tier).toBeDefined();
	});

	test('creating a component with an assembly adds a BOM line in the same step', async () => {
		const { api, create } = await setup();
		const asm = await create({ name: 'Asm' });
		const c = await api('POST', '/parts', { name: 'Comp', tier: 1, assemblyId: asm.id, assemblyQuantity: '4' });
		expect(c.status).toBe(201);
		const bom = (await api('GET', `/parts/${asm.id}/bom`)).json;
		expect(bom.map((l: any) => [l.componentId, l.quantity])).toEqual([[c.json.id, '4']]);
	});

	test('a creation for a missing assembly fails and creates nothing', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts', { name: 'Orphan', tier: 1, assemblyId: 999 });
		expect(res.status).toBe(404);
		expect((await api('GET', '/parts')).json.items).toHaveLength(0);
	});

	test('a failed write rolls back, audit rows included', async () => {
		const { db, api } = await setup();
		await api('POST', '/parts', { name: 'A', tier: 1, internalPn: 'PN-1-0100' });
		const before = db.select().from(auditLog).all().length;
		const res = await api('POST', '/parts', { name: 'B', tier: 1, internalPn: 'PN-1-0100' });
		expect(res.status).toBe(409);
		expect(db.select().from(auditLog).all()).toHaveLength(before);
	});

	test('custom fields are checked against the project definitions', async () => {
		const { api, configureProject } = await setup();
		configureProject({
			tiers: [{ level: 1, name: 'T', code: 'T' }],
			custom_fields: { finish: ['anodized', 'raw'], mass_g: 'number', batch: { type: 'text', required: true } }
		});
		const ok = await api('POST', '/parts', { name: 'A', tier: 1, metadata: { finish: 'raw', mass_g: 12.5, batch: 'b1', free: [1] } });
		expect(ok.status).toBe(201);
		expect(ok.json.metadata).toEqual({ finish: 'raw', mass_g: 12.5, batch: 'b1', free: [1] });
		const bad = await api('POST', '/parts', { name: 'B', tier: 1, metadata: { finish: 'chrome', mass_g: 'heavy' } });
		expect(bad.status).toBe(422);
		expect(Object.keys(bad.json.fields).sort()).toEqual(['metadata.batch', 'metadata.finish', 'metadata.mass_g']);
	});

	test('the part schema carries tiers, categories, custom fields and the numbering format', async () => {
		const { api, create, configureProject } = await setup();
		configureProject({
			tiers: [{ level: 1, name: 'Flight', code: 'F' }],
			categories: ['Fasteners'],
			custom_fields: { finish: ['a', 'b'] }
		});
		await create({ name: 'A', category: 'Brackets' });
		const s = (await api('GET', '/parts/schema')).json;
		expect(s.tiers[0]).toMatchObject({ level: 1, name: 'Flight', code: 'F', defaultTracking: 'serialized' });
		expect(s.categories).toEqual(['Brackets', 'Fasteners']);
		expect(s.customFields[0]).toMatchObject({ key: 'finish', type: 'select', options: ['a', 'b'] });
		expect(s.numberingFormat).toBe('{prefix}{sep}{tier_code}{sep}{sequence}');
	});

	test('without a project the schema offers three fallback tiers', async () => {
		const { api } = await setup();
		const s = (await api('GET', '/parts/schema')).json;
		expect(s.tiers.map((t: any) => t.level)).toEqual([1, 2, 3]);
		expect(s.numberingFormat).toBeNull();
	});
});

describe('part list', () => {
	test('list paginates with a cursor, newest first', async () => {
		const { api, create } = await setup();
		for (const name of ['A', 'B', 'C']) await create({ name });
		const first = (await api('GET', '/parts?limit=2')).json;
		expect(first.items.map((p: any) => p.name)).toEqual(['C', 'B']);
		const second = (await api('GET', `/parts?limit=2&cursor=${first.next}`)).json;
		expect(second.items.map((p: any) => p.name)).toEqual(['A']);
		expect(second.next).toBeNull();
	});

	test('search matches name, part numbers and description', async () => {
		const { api, create } = await setup();
		await create({ name: 'Widget', description: 'has a flange' });
		await create({ name: 'Other', externalPn: 'MCM-9' });
		const names = async (q: string) => (await api('GET', `/parts?q=${q}`)).json.items.map((p: any) => p.name);
		expect(await names('widg')).toEqual(['Widget']);
		expect(await names('flange')).toEqual(['Widget']);
		expect(await names('MCM')).toEqual(['Other']);
		expect(await names('PN-1')).toEqual(['Other', 'Widget']);
	});

	test('filters: category, tier, procurement, tooling, state', async () => {
		const { api, create, activate } = await setup();
		const a = await create({ name: 'Zeta', procurement: 'buy', category: 'Fasteners' });
		const b = await create({ name: 'Alpha', tier: 2, isTooling: true, calibrationIntervalDays: 365 });
		await activate(a.id);
		const ids = async (qs: string) => (await api('GET', `/parts?${qs}`)).json.items.map((p: any) => p.id);
		expect(await ids('category=Fasteners')).toEqual([a.id]);
		expect(await ids('tier=2')).toEqual([b.id]);
		expect(await ids('procurement=buy')).toEqual([a.id]);
		expect(await ids('tooling=true')).toEqual([b.id]);
		expect(await ids('tooling=false')).toEqual([a.id]);
		expect(await ids('state=active')).toEqual([a.id]);
		expect(await ids('state=draft')).toEqual([b.id]);
		expect((await api('GET', '/parts?procurement=steal')).status).toBe(422);
		expect((await api('GET', '/parts?sort=bogus')).status).toBe(422);
	});

	test('sorting by name ignores case and paginates in that order', async () => {
		const { api, create } = await setup();
		for (const name of ['beta', 'Alpha', 'gamma']) await create({ name });
		const asc = (await api('GET', '/parts?sort=name&dir=asc&limit=2')).json;
		expect(asc.items.map((p: any) => p.name)).toEqual(['Alpha', 'beta']);
		const rest = (await api('GET', `/parts?sort=name&dir=asc&limit=2&cursor=${asc.next}`)).json;
		expect(rest.items.map((p: any) => p.name)).toEqual(['gamma']);
	});

	test('usedIn lists the components of one assembly; topLevel lists parts in no BOM', async () => {
		const { api, create } = await setup();
		const asm = await create({ name: 'Asm' });
		const c1 = await create({ name: 'C1' });
		await create({ name: 'C2' });
		await api('POST', `/parts/${asm.id}/bom`, { componentId: c1.id });
		const names = async (qs: string) => (await api('GET', `/parts?${qs}&sort=name&dir=asc`)).json.items.map((p: any) => p.name);
		expect(await names(`usedIn=${asm.id}`)).toEqual(['C1']);
		expect(await names('topLevel=true')).toEqual(['Asm', 'C2']);
		expect(await names('topLevel=false')).toEqual(['C1']);
	});

	test('an unknown part is 404 on get, detail and history', async () => {
		const { api } = await setup();
		for (const path of ['/parts/999', '/parts/999/detail', '/parts/999/history']) {
			expect((await api('GET', path)).status).toBe(404);
		}
	});

	test('categories lists the categories in use', async () => {
		const { api, create } = await setup();
		await create({ name: 'A', category: 'Brackets' });
		await create({ name: 'B', category: 'Fasteners' });
		await create({ name: 'C', category: 'Brackets' });
		await create({ name: 'D' });
		expect((await api('GET', '/parts/categories')).json).toEqual(['Brackets', 'Fasteners']);
	});
});

describe('part update', () => {
	test('update changes the given fields only', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'Old', description: 'd', category: 'c' });
		const res = await api('PATCH', `/parts/${p.id}`, { name: 'New', unitOfMeasure: 'kg' });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ name: 'New', unitOfMeasure: 'kg', description: 'd', category: 'c' });
	});

	test('an explicit null on a non-nullable field is refused', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'A' });
		for (const field of ['name', 'unitOfMeasure', 'trackingType', 'tier', 'isTooling']) {
			expect((await api('PATCH', `/parts/${p.id}`, { [field]: null })).status).toBe(422);
		}
	});

	test('an explicit null clears nullable fields', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'A', externalPn: 'X', description: 'd', category: 'c', reorderPoint: '3' });
		const res = await api('PATCH', `/parts/${p.id}`, { externalPn: null, description: null, category: null, reorderPoint: null });
		expect(res.json).toMatchObject({ externalPn: null, description: null, category: null, reorderPoint: null });
	});

	test('procurement can be edited', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'A' });
		expect((await api('PATCH', `/parts/${p.id}`, { procurement: 'both' })).json.procurement).toBe('both');
	});

	test('a part cannot get a negative reorder point', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'A' });
		expect((await api('PATCH', `/parts/${p.id}`, { reorderPoint: '-2' })).status).toBe(422);
	});

	test('tracking cannot change once a stock reference exists', async () => {
		const { api, create, db } = await setup();
		const { registerPartReference } = await import('../../src/services/parts/references.ts');
		let stock = 0;
		registerPartReference({ name: 'test_stock', locksTracking: true, count: () => stock });
		const p = await create({ name: 'A', trackingType: 'bulk' });
		expect((await api('PATCH', `/parts/${p.id}`, { trackingType: 'serialized' })).status).toBe(200);
		stock = 1;
		const res = await api('PATCH', `/parts/${p.id}`, { trackingType: 'bulk' });
		expect(res.status).toBe(409);
		expect(res.json.error).toBe('has_stock');
		stock = 0;
		void db;
	});

	test('history lists changes newest first and skips bookkeeping columns', async () => {
		const { api, create, activate } = await setup();
		const p = await create({ name: 'A' });
		await activate(p.id);
		const h = (await api('GET', `/parts/${p.id}/history`)).json;
		expect(h.total).toBe(2);
		expect(h.items[0].action).toBe('update');
		const fields = Object.fromEntries(h.items[0].changes.map((c: any) => [c.field, c]));
		expect(fields.state).toMatchObject({ old: 'draft', new: 'active' });
		expect(fields.updatedAt).toBeUndefined();
		expect(h.items.at(-1).action).toBe('create');
	});
});

describe('part qr code', () => {
	test('the QR code is an SVG that encodes the page URL', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'A' });
		const r = await api('GET', `/parts/${p.id}/qrcode?origin=http://opal.local:8080`);
		expect(r.json.url).toBe(`http://opal.local:8080/parts/${p.id}`);
		expect(r.json.svg).toContain('<svg');
	});
});
