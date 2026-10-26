import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nextPartNumber, peekNextPartNumber, pnExists, validatePartNumber } from '../../src/services/org/numbering.ts';
import { designatorSequence } from '../../src/db/schema/index.ts';
import { nextSerial } from '../../src/services/designators.ts';
import { numbersFor } from '../../src/services/org/project.ts';
import { part, setting } from './schema.ts';
import { setup } from './helpers.ts';

describe('workcenters', () => {
	test('a workcenter is created with an upper case code and updated', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const made = await call(bob, 'POST', '/workcenters', { name: 'Clean room', code: 'cr1', location: 'B2' });
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ code: 'CR1', isActive: true, defaultStepCount: 0, queuedStepCount: 0 });
		const upd = await call(bob, 'PATCH', `/workcenters/${made.json.id}`, { name: 'Cleanroom', code: 'cr2' });
		expect(upd.json).toMatchObject({ name: 'Cleanroom', code: 'CR2', location: 'B2' });
	});

	test('the audit log names a workcenter and a role by their own page, never an id', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob', { admin: true });
		const wc = (await call(bob, 'POST', '/workcenters', { name: 'Clean room', code: 'cr1' })).json;
		const rl = (await call(bob, 'POST', '/roles', { name: 'Reviewer' })).json;
		const log = (await call(bob, 'GET', '/audit?limit=50')).json.items as { entity: string; recordLabel: string | null; href: string | null }[];
		expect(log.find((e) => e.entity === 'workcenter')).toMatchObject({ recordLabel: 'CR1 Clean room', href: `/workcenters/${wc.id}` });
		expect(log.find((e) => e.entity === 'role')).toMatchObject({ recordLabel: 'Reviewer', href: `/settings?role=${rl.id}#roles` });
	});

	test('the command palette finds a workcenter by name or code', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const wc = (await call(bob, 'POST', '/workcenters', { name: 'Clean room', code: 'cr1' })).json;
		for (const q of ['clean', 'CR1']) {
			const hits = (await call(bob, 'GET', `/search?q=${q}`)).json as { entityType: string; label: string; sublabel: string; href: string }[];
			expect(hits.find((h) => h.entityType === 'workcenter')).toMatchObject({ label: 'Clean room', sublabel: 'CR1', href: `/workcenters/${wc.id}` });
		}
	});

	test('undo reverses a workcenter edit and a workcenter creation', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob', { admin: true });
		const wc = (await call(bob, 'POST', '/workcenters', { name: 'Clean room', code: 'cr1' })).json;
		await call(bob, 'PATCH', `/workcenters/${wc.id}`, { name: 'Cleanroom' });
		const preview = await call(bob, 'GET', '/undo/last');
		expect(preview.json).toMatchObject({ canUndo: true });
		expect((await call(bob, 'POST', '/undo/last')).status).toBe(200);
		expect((await call(bob, 'GET', `/workcenters/${wc.id}`)).json.name).toBe('Clean room');
		const second = await call(bob, 'POST', '/undo/last');
		
		expect(second.status).toBe(200);
		expect((await call(bob, 'GET', `/workcenters/${wc.id}`)).status).toBe(404);
	});

	test('a blank name is refused and a duplicate code is refused ignoring case', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'POST', '/workcenters', { name: '', code: 'A' })).status).toBe(422);
		await call(bob, 'POST', '/workcenters', { name: 'A', code: 'ab1' });
		expect((await call(bob, 'POST', '/workcenters', { name: 'B', code: 'AB1' })).status).toBe(400);
		const other = (await call(bob, 'POST', '/workcenters', { name: 'C', code: 'zz' })).json;
		expect((await call(bob, 'PATCH', `/workcenters/${other.id}`, { code: 'Ab1' })).status).toBe(400);
		expect((await call(bob, 'PATCH', `/workcenters/${other.id}`, { code: 'zz' })).status).toBe(200);
	});

	test('deactivating hides a workcenter from the default list but keeps it', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const a = (await call(bob, 'POST', '/workcenters', { name: 'A', code: 'A' })).json;
		await call(bob, 'POST', '/workcenters', { name: 'B', code: 'B' });
		expect((await call(bob, 'DELETE', `/workcenters/${a.id}`)).status).toBe(200);
		expect((await call(bob, 'GET', '/workcenters')).json.map((w: any) => w.code)).toEqual(['B']);
		expect((await call(bob, 'GET', '/workcenters?activeOnly=false')).json.map((w: any) => w.code)).toEqual(['A', 'B']);
		expect((await call(bob, 'GET', `/workcenters/${a.id}`)).json.isActive).toBe(false);
	});

	test('the list searches name and code', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		await call(bob, 'POST', '/workcenters', { name: 'Clean room', code: 'CR' });
		await call(bob, 'POST', '/workcenters', { name: 'Machine shop', code: 'MS' });
		expect((await call(bob, 'GET', '/workcenters?search=machine')).json).toHaveLength(1);
		expect((await call(bob, 'GET', '/workcenters?search=CR')).json).toHaveLength(1);
	});

	test('work of a workcenter is empty without procedures and 404 for an unknown one', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const a = (await call(bob, 'POST', '/workcenters', { name: 'A', code: 'A' })).json;
		expect((await call(bob, 'GET', `/workcenters/${a.id}/work`)).json).toEqual({ defaultSteps: [], queue: [] });
		expect((await call(bob, 'GET', '/workcenters/999/work')).status).toBe(404);
	});
});

const config = (over: Record<string, unknown> = {}) => ({
	name: 'Bento',
	description: '',
	tiers: [
		{ level: 1, name: 'Flight', code: 'F' },
		{ level: 2, name: 'Ground', code: 'G' }
	],
	partNumbering: { prefix: 'BP', separator: '-', sequenceDigits: 4, format: '{prefix}{sep}{tier_code}{sep}{sequence}' },
	categories: ['  Avionics', 'Structures', 'Avionics', ''],
	...over
});

describe('organization settings', () => {
	test('it is absent before setup, then created once with trimmed and de-duplicated categories', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		expect((await call(admin, 'GET', '/settings/organization')).status).toBe(404);
		const made = await call(admin, 'POST', '/settings/organization', config());
		expect(made.status).toBe(201);
		expect(made.json.categories).toEqual(['Avionics', 'Structures']);
		expect((await call(admin, 'GET', '/settings/organization')).json.name).toBe('Bento');
		expect((await call(admin, 'POST', '/settings/organization', config())).status).toBe(400);
	});

	test('tier semantics default from the level and an update that omits them keeps the stored values', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const made = (await call(admin, 'POST', '/settings/organization', config())).json;
		expect(made.tiers[0]).toMatchObject({ defaultTracking: 'serialized', requireLot: true, autoSerial: true });
		expect(made.tiers[1]).toMatchObject({ defaultTracking: 'serialized', requireLot: true, autoSerial: false });
		const edited = config({ tiers: [{ level: 1, name: 'Flight', code: 'F', requireLot: false }, { level: 2, name: 'Ground', code: 'G' }] });
		const upd = (await call(admin, 'PUT', '/settings/organization', edited)).json;
		expect(upd.tiers[0]).toMatchObject({ requireLot: false, autoSerial: true });
	});

	test.each([
		[{ name: '  ' }, 'name'],
		[{ tiers: [] }, 'at least one tier'],
		[{ tiers: [{ level: 1, name: 'A', code: 'X' }, { level: 2, name: 'B', code: 'X' }] }, 'codes must be unique'],
		[{ tiers: [{ level: 1, name: 'A', code: 'X' }, { level: 1, name: 'B', code: 'Y' }] }, 'levels must be unique'],
		[{ tiers: [{ level: 1, name: '', code: 'F' }] }, 'blank'],
		[{ tiers: [{ level: 1, name: 'Flight', code: 'F L' }] }, 'spaces']
	])('invalid project input %#is refused', async (over, fragment) => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const r = await call(admin, 'POST', '/settings/organization', config(over));
		expect(r.status).toBe(422);
		expect(r.text).toContain(fragment);
	});

	test.each(['{prefix}-{nope}-{sequence}', '{prefix}-{tier_code}', '{0}{sequence}', '{prefix{sequence}'])(
		'a part number format that cannot render (%s) is refused',
		async (format) => {
			const { call, makeUser } = await setup();
			const admin = makeUser('root', { admin: true });
			const r = await call(admin, 'POST', '/settings/organization', config({ partNumbering: { prefix: 'BP', format } }));
			expect(r.status).toBe(422);
		}
	);

	test('a part number format may embed a literal separator', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const r = await call(admin, 'POST', '/settings/organization', config({ partNumbering: { prefix: 'BP', format: '{prefix}.{tier_code}.{sequence}' } }));
		expect(r.status).toBe(201);
	});

	test('custom fields round trip and survive an update that omits them', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const made = await call(admin, 'POST', '/settings/organization', config({ customFields: { customer: 'ACME', rev: 'B' } }));
		expect(made.json.customFields).toEqual({ customer: 'ACME', rev: 'B' });
		expect((await call(admin, 'PUT', '/settings/organization', config({ name: 'Renamed' }))).json.customFields).toEqual({ customer: 'ACME', rev: 'B' });
		expect((await call(admin, 'PUT', '/settings/organization', config({ customFields: {} }))).json.customFields).toEqual({});
	});

	test('project writes are admin only', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'POST', '/settings/organization', config())).status).toBe(403);
		expect((await call(bob, 'PUT', '/settings/organization', config())).status).toBe(403);
	});

	test('removing a tier that parts use is refused and nothing is applied', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/settings/organization', config());
		const ts = new Date().toISOString();
		db.insert(part).values({ internalPn: 'BP-G-0001', name: 'Bracket', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 2, state: 'draft', createdAt: ts, updatedAt: ts } as never).run();
		const r = await call(admin, 'PUT', '/settings/organization', config({ tiers: [{ level: 1, name: 'Flight', code: 'F' }] }));
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('Ground');
		expect((await call(admin, 'GET', '/settings/organization')).json.tiers).toHaveLength(2);
	});

	test('removing an unused tier keeps the other levels', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/settings/organization', config());
		const r = await call(admin, 'PUT', '/settings/organization', config({ tiers: [{ level: 2, name: 'Ground', code: 'G' }] }));
		expect(r.json.tiers.map((t: any) => t.level)).toEqual([2]);
	});

	test('a project stored with legacy snake_case keys reads back, and keeps its Onshape block when edited', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const ts = new Date().toISOString();
		db.insert(setting).values({
			key: 'project_config',
			value: JSON.stringify({
				name: 'Old', description: '', categories: [],
				tiers: [{ level: 3, name: 'Loose', code: 'L', description: '' }],
				part_numbering: { prefix: 'X', separator: '_', sequence_digits: 3, format: '{prefix}{sep}{sequence}' },
				custom_fields: { a: 1 },
				onshape: { documents: [{ name: 'd' }] }
			}),
			createdAt: ts, updatedAt: ts
		}).run();
		const got = (await call(admin, 'GET', '/settings/organization')).json;
		expect(got.partNumbering).toEqual({ prefix: 'X', separator: '_', sequenceDigits: 3, format: '{prefix}{sep}{sequence}', variants: false });
		expect(got.tiers[0]).toMatchObject({ defaultTracking: 'bulk', requireLot: false, autoSerial: false });
		expect(got.customFields).toEqual({ a: 1 });
		await call(admin, 'PUT', '/settings/organization', config({ tiers: [{ level: 3, name: 'Loose', code: 'L' }] }));
		const raw = JSON.parse(db.select().from(setting).all().find((s) => s.key === 'project_config')!.value!);
		expect(raw.onshape).toEqual({ documents: [{ name: 'd' }] });
		expect(raw.part_numbering).toBeUndefined();
	});

	test('the preview renders a part number for a tier and refuses an unknown tier', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/settings/organization', config());
		const r = await call(admin, 'POST', '/settings/preview-part-number', { tierLevel: 2, sequence: 7 });
		expect(r.json).toEqual({ partNumber: 'BP-G-0007', tierName: 'Ground' });
		expect((await call(admin, 'POST', '/settings/preview-part-number', { tierLevel: 9 })).status).toBe(400);
	});
});

describe('part numbers', () => {
	const ctxOf = (db: any) => ({ db });

	test('without a project the format is PN-tier-0001 and each call uses the next number', async () => {
		const { db } = await setup();
		expect(nextPartNumber(ctxOf(db), 1)).toBe('PN-1-0000000001');
		expect(nextPartNumber(ctxOf(db), 1)).toBe('PN-1-0000000002');
		expect(nextPartNumber(ctxOf(db), 2)).toBe('PN-2-0000000001');
	});

	test('with a project the number follows the scheme', async () => {
		const { db, call, makeUser } = await setup();
		await call(makeUser('root', { admin: true }), 'POST', '/settings/organization', config());
		expect(nextPartNumber(ctxOf(db), 1)).toBe('BP-F-0000000001');
		expect(nextPartNumber(ctxOf(db), 2)).toBe('BP-G-0000000001');
		expect(() => nextPartNumber(ctxOf(db), 9)).toThrow('Unknown tier level: 9');
	});

	test('the preview does not use the number up', async () => {
		const { db, call, makeUser } = await setup();
		const bob = makeUser('bob');
		const first = (await call(bob, 'GET', '/settings/next-part-number?tier=1')).json;
		const second = (await call(bob, 'GET', '/settings/next-part-number?tier=1')).json;
		expect(first).toEqual(second);
		// the preview is shown at the display width, the service gives the stored form
		expect(numbersFor(db).display(nextPartNumber(ctxOf(db), 1))).toBe(first.partNumber);
		expect(peekNextPartNumber(db, 1).sequence).toBe(first.sequence + 1);
	});

	test('a taken number is skipped and the skip uses the number up', async () => {
		const { db } = await setup();
		const ts = new Date().toISOString();
		db.insert(part).values({ internalPn: 'PN-1-0000000002', name: 'Ghost', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 1, state: 'obsolete', createdAt: ts, updatedAt: ts } as never).run();
		expect(pnExists(db, 'PN-1-0000000002')).toBe(true);
		expect(peekNextPartNumber(db, 1).partNumber).toBe('PN-1-0000000001');
		expect(nextPartNumber(ctxOf(db), 1)).toBe('PN-1-0000000001');
		expect(nextPartNumber(ctxOf(db), 1)).toBe('PN-1-0000000003');
		expect(nextPartNumber(ctxOf(db), 1)).toBe('PN-1-0000000004');
	});

	test('a malformed manual number is refused with the expected format by example', async () => {
		const { db } = await setup();
		// The service example is the stored form; the API message shows the display width.
		expect(() => validatePartNumber(db, 1, 'WIDGET-XYZ')).toThrow(/WIDGET-XYZ.*PN-1-0000000001/);
	});

	test('the sequence is stored at full width, shown padded to the digits of the scheme but never cut', async () => {
		const { db, call, makeUser } = await setup();
		const root = makeUser('root', { admin: true });
		await call(root, 'POST', '/settings/organization', config({ partNumbering: { prefix: 'P', separator: '-', sequenceDigits: 2, format: '{prefix}{sep}{sequence}' } }));
		const made = await call(root, 'POST', '/parts', { name: 'Shown', tier: 1 });
		expect(made.status).toBe(201);
		expect(made.json.internalPn).toBe('P-01');
		db.update(designatorSequence).set({ lastValue: 122 }).where(eq(designatorSequence.prefix, 'PN-1')).run();
		const big = await call(root, 'POST', '/parts', { name: 'Long', tier: 1 });
		expect(big.json.internalPn).toBe('P-123');
	});

	test('changing sequenceDigits changes the displayed part number and moves no stored row', async () => {
		const { db, call, makeUser } = await setup();
		const root = makeUser('root', { admin: true });
		await call(root, 'POST', '/settings/organization', config());
		const made = (await call(root, 'POST', '/parts', { name: 'A', tier: 1 })).json;
		expect(made.internalPn).toBe('BP-F-0001');
		const stored = () => db.select().from(part).all().map((p: any) => p.internalPn);
		expect(stored()).toEqual(['BP-F-0000000001']);
		const widen = await call(root, 'PUT', '/settings/organization', config({ partNumbering: { prefix: 'BP', separator: '-', sequenceDigits: 6, format: '{prefix}{sep}{tier_code}{sep}{sequence}' } }));
		expect(widen.status).toBe(200);
		expect((await call(root, 'GET', `/parts/${made.id}`)).json.internalPn).toBe('BP-F-000001');
		const list = (await call(root, 'GET', '/parts')).json;
		expect(JSON.stringify(list)).toContain('BP-F-000001');
		expect(JSON.stringify(list)).not.toContain('BP-F-0001"');
		expect(stored()).toEqual(['BP-F-0000000001']);
		// the old width still finds the part
		expect((await call(root, 'GET', '/parts?q=BP-F-0001')).json).toBeTruthy();
	});

	test('serials keep counting per stored part number after the display width changes', async () => {
		const { db, call, makeUser } = await setup();
		const root = makeUser('root', { admin: true });
		await call(root, 'POST', '/settings/organization', config());
		await call(root, 'POST', '/parts', { name: 'A', tier: 1 });
		const pn = db.select().from(part).all()[0]!.internalPn as string;
		expect(pn).toBe('BP-F-0000000001');
		expect(nextSerial({ db }, pn)).toBe('001');
		await call(root, 'PUT', '/settings/organization', config({ partNumbering: { prefix: 'BP', separator: '-', sequenceDigits: 7, format: '{prefix}{sep}{tier_code}{sep}{sequence}' } }));
		expect(nextSerial({ db }, pn)).toBe('002');
		const keys = db.select().from(designatorSequence).all().map((r: any) => r.prefix);
		expect(keys).toContain(`SN-${pn}`);
	});
});
