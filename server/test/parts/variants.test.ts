import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { appSetting, designatorSequence } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

const TIERS = [
	{ level: 1, name: 'Flight', code: 'F' },
	{ level: 2, name: 'Ground', code: 'G' }
];
const ON = '{prefix}{sep}{tier_code}{sep}{sequence}{sep}{variant}';
const OFF = '{prefix}{sep}{tier_code}{sep}{sequence}';

async function org(format = ON) {
	const s = await setup();
	s.configureProject({ tiers: TIERS, part_numbering: { prefix: 'SPX', separator: '-', sequence_digits: 4, format } });
	/** Change the stored format in place, as an admin's settings save would. */
	const reformat = (next: string) => {
		const row = s.db.select().from(appSetting).where(eq(appSetting.key, 'project_config')).get()!;
		const blob = JSON.parse(row.value!);
		blob.part_numbering.format = next;
		s.db.update(appSetting).set({ value: JSON.stringify(blob) }).where(eq(appSetting.key, 'project_config')).run();
	};
	const variant = async (id: number, body: Record<string, unknown> = {}) => s.api('POST', `/parts/${id}/variants`, body);
	const counter = (prefix: string) =>
		s.db.select().from(designatorSequence).where(eq(designatorSequence.prefix, prefix)).get()?.lastValue;
	return { ...s, reformat, variant, counter };
}

describe('part number variants', () => {
	test('a new part is variant 001 of a new family', async () => {
		const { create, counter } = await org();
		const a = await create({ name: 'Strut' });
		const b = await create({ name: 'Bracket', tier: 2 });
		expect(a.internalPn).toBe('SPX-F-0001-001');
		expect(b.internalPn).toBe('SPX-G-0001-001');
		expect(counter('PNV-SPX-F-0000000001')).toBe(1);
	});

	test('bulk create and reserve give every new part variant 001', async () => {
		const { api } = await org();
		const bulk = await api('POST', '/parts/bulk', { parts: [{ name: 'A' }, { name: 'B' }] });
		expect(bulk.json.parts.map((p: any) => p.internalPn)).toEqual(['PN-1-0001', 'PN-1-0002'].map((_, i) => `SPX-F-000${i + 1}-001`));
		const res = await api('POST', '/parts/reserve', { tier: 1, count: 2 });
		expect(res.json.parts.map((p: any) => p.internalPn)).toEqual(['SPX-F-0003-001', 'SPX-F-0004-001']);
		expect(res.json.parts[0].name).toBe('RESERVED-0000000003');
		const imp = await api('POST', '/parts/import', { rows: [{ name: 'Imported', tier: 1 }] });
		expect(imp.json.firstPn).toBe('SPX-F-0005-001');
	});

	test('a variant takes the next code of its family and the tier counter does not move', async () => {
		const { api, create, variant, counter } = await org();
		const bare = await create({ name: 'Strut, machined' });
		const coated = (await variant(bare.id, { name: 'Strut, alodine' })).json;
		const built = (await variant(coated.id, { name: 'Strut assembly' })).json;
		expect([coated.internalPn, built.internalPn]).toEqual(['SPX-F-0001-002', 'SPX-F-0001-003']);
		expect(counter('PN-1')).toBe(1);
		expect((await api('GET', '/parts/next-pn?tier=1')).json.partNumber).toBe('SPX-F-0002-001');
		expect((await create({ name: 'Next' })).internalPn).toBe('SPX-F-0002-001');
	});

	test('a variant code is never reused after its part is deleted', async () => {
		const { api, create, variant } = await org();
		const base = await create({ name: 'Strut' });
		const two = (await variant(base.id, { bom: 'empty' })).json;
		expect((await api('DELETE', `/parts/${two.id}`)).status).toBe(200);
		expect((await api('GET', `/parts/${base.id}/detail`)).json.family.nextNumber).toBe('SPX-F-0001-003');
		expect((await variant(base.id)).json.internalPn).toBe('SPX-F-0001-003');
	});

	test('a part from before variants were on anchors its family as 001', async () => {
		const { api, create, variant, reformat, counter } = await org(OFF);
		const legacy = await create({ name: 'Strut' });
		expect(legacy.internalPn).toBe('SPX-F-0001');
		reformat(ON);
		const v = await variant(legacy.id);
		expect(v.status).toBe(201);
		expect(v.json.internalPn).toBe('SPX-F-0001-002');
		expect(counter('PNV-SPX-F-0000000001')).toBe(2);
		const fam = (await api('GET', `/parts/${v.json.id}/detail`)).json.family;
		expect(fam.baseNumber).toBe('SPX-F-0001');
		expect(fam.members.map((m: any) => [m.internalPn, m.variant])).toEqual([
			['SPX-F-0001', '001'],
			['SPX-F-0001-002', '002']
		]);
		expect((await api('GET', `/parts/${legacy.id}`)).json.internalPn).toBe('SPX-F-0001');
	});

	test('a number outside the scheme anchors its own family', async () => {
		const { api, create, variant, db } = await org();
		const odd = await create({ name: 'Imported' });
		db.$client.query('update part set internal_pn = ? where id = ?').run('LEGACY-12', odd.id);
		const v = (await variant(odd.id)).json;
		expect(v.internalPn).toBe('LEGACY-12-002');
		const fam = (await api('GET', `/parts/${v.id}/detail`)).json.family;
		expect(fam.baseNumber).toBe('LEGACY-12');
		expect(fam.members.map((m: any) => m.internalPn)).toEqual(['LEGACY-12', 'LEGACY-12-002']);
	});

	test('a variant is refused while variants are off', async () => {
		const { create, variant } = await org(OFF);
		const p = await create({ name: 'Strut' });
		const res = await variant(p.id);
		expect(res.status).toBe(409);
		expect(res.json.error).toBe('variants_off');
	});

	test('a family refuses a variant after code 999', async () => {
		const { create, variant, db } = await org();
		const p = await create({ name: 'Strut' });
		db.update(designatorSequence).set({ lastValue: 998 }).where(eq(designatorSequence.prefix, 'PNV-SPX-F-0000000001')).run();
		expect((await variant(p.id)).json.internalPn).toBe('SPX-F-0001-999');
		const res = await variant(p.id);
		expect(res.status).toBe(409);
		expect(res.json.error).toBe('numbers_exhausted');
		expect(res.json.message).toContain('SPX-F-0001');
	});

	test('the source BOM mode makes the source part the one BOM line', async () => {
		const { api, create, variant } = await org();
		const p = await create({ name: 'Strut' });
		const v = (await variant(p.id)).json;
		const bom = (await api('GET', `/parts/${v.id}/bom`)).json;
		expect(bom.map((l: any) => [l.componentPn, l.quantity])).toEqual([['SPX-F-0001-001', '1']]);
	});

	test('the copy BOM mode copies the source BOM lines', async () => {
		const { api, create, variant } = await org();
		const asm = await create({ name: 'Strut assembly' });
		const bearing = await create({ name: 'Bearing', tier: 2 });
		const rod = await create({ name: 'Rod', tier: 2 });
		await api('POST', `/parts/${asm.id}/bom`, { componentId: bearing.id, quantity: '2', referenceDesignator: 'B1', notes: 'press fit' });
		await api('POST', `/parts/${asm.id}/bom`, { componentId: rod.id, quantity: '0.5' });
		const v = (await variant(asm.id, { bom: 'copy' })).json;
		const bom = (await api('GET', `/parts/${v.id}/bom`)).json;
		expect(bom.map((l: any) => [l.componentId, l.quantity, l.referenceDesignator, l.notes])).toEqual([
			[bearing.id, '2', 'B1', 'press fit'],
			[rod.id, '0.5', null, null]
		]);
	});

	test('the empty BOM mode leaves the BOM empty', async () => {
		const { api, create, variant } = await org();
		const p = await create({ name: 'Strut' });
		const v = (await variant(p.id, { bom: 'empty' })).json;
		expect((await api('GET', `/parts/${v.id}/bom`)).json).toEqual([]);
	});

	test('a variant copies the attributes unless given, stays in the tier and starts as a draft', async () => {
		const { api, create, variant, activate } = await org();
		const p = await create({
			name: 'Strut',
			description: 'Machined 6061',
			category: 'Structure',
			externalPn: 'CAD-77',
			unitOfMeasure: 'ea',
			trackingType: 'serialized',
			reorderPoint: '4'
		});
		await activate(p.id);
		const v = (await variant(p.id, { name: 'Strut, alodine', category: null, tier: 2, internalPn: 'X-1' })).json;
		expect(v).toMatchObject({
			name: 'Strut, alodine',
			description: 'Machined 6061',
			category: null,
			externalPn: 'CAD-77',
			trackingType: 'serialized',
			reorderPoint: '4',
			tier: 1,
			state: 'draft',
			internalPn: 'SPX-F-0001-002'
		});
		expect((await api('GET', `/parts/${v.id}/history`)).json.items.every((h: any) => h.action === 'create')).toBe(true);
	});

	test('a search for the base number finds the whole family', async () => {
		const { api, create, variant } = await org();
		const p = await create({ name: 'Strut' });
		await variant(p.id);
		await variant(p.id);
		await create({ name: 'Other' });
		for (const q of ['SPX-F-0001', 'SPX-F-1', 'SPX-F-00001']) {
			const res = await api('GET', `/parts?q=${q}&sort=internalPn&dir=asc`);
			expect(res.json.items.map((x: any) => x.internalPn)).toEqual(['SPX-F-0001-001', 'SPX-F-0001-002', 'SPX-F-0001-003']);
		}
		const one = await api('GET', '/parts?q=SPX-F-1-2');
		expect(one.json.items.map((x: any) => x.internalPn)).toEqual(['SPX-F-0001-002']);
	});

	test('the part page lists the family in code order with the next number', async () => {
		const { api, create, variant } = await org();
		const p = await create({ name: 'Strut' });
		const two = (await variant(p.id, { name: 'Coated' })).json;
		const fam = (await api('GET', `/parts/${two.id}/detail`)).json.family;
		expect(fam).toEqual({
			baseNumber: 'SPX-F-0001',
			variants: true,
			nextNumber: 'SPX-F-0001-003',
			members: [
				{ id: p.id, internalPn: 'SPX-F-0001-001', variant: '001', name: 'Strut', state: 'draft', trackingType: 'serialized' },
				{ id: two.id, internalPn: 'SPX-F-0001-002', variant: '002', name: 'Coated', state: 'draft', trackingType: 'serialized' }
			]
		});
	});

	test('a family of one shows its base number and no next number while variants are off', async () => {
		const { api, create } = await org(OFF);
		const p = await create({ name: 'Strut' });
		const fam = (await api('GET', `/parts/${p.id}/detail`)).json.family;
		expect(fam).toMatchObject({ baseNumber: 'SPX-F-0001', variants: false, nextNumber: null });
		expect(fam.members).toHaveLength(1);
	});

	test('a variant number reads at any sequence width', async () => {
		const { api, create, variant } = await org();
		const p = await create({ name: 'Strut' });
		await variant(p.id);
		const label = await api('GET', `/parts?q=SPX-F-00001-002`);
		expect(label.json.items.map((x: any) => x.internalPn)).toEqual(['SPX-F-0001-002']);
	});
});

describe('variant settings', () => {
	const body = (partNumbering: Record<string, unknown>) => ({
		name: 'Org',
		tiers: TIERS.map((t) => ({ ...t, description: '', defaultTracking: 'serialized', requireLot: false, autoSerial: false })),
		partNumbering: { prefix: 'SPX', separator: '-', sequenceDigits: 4, ...partNumbering }
	});

	test('an organization without the field reads as variants off', async () => {
		const { api } = await org(OFF);
		expect((await api('GET', '/settings/organization')).json.partNumbering).toMatchObject({ format: OFF, variants: false });
	});

	test('variants on need {variant} at the end of the format, after the sequence', async () => {
		const { api } = await org(OFF);
		for (const format of [OFF, '{prefix}{sep}{variant}{sep}{sequence}', '{prefix}{sep}{tier_code}{sep}{sequence}{variant}']) {
			const res = await api('PUT', '/settings/organization', body({ format, variants: true }));
			expect(res.status).toBe(422);
			expect(JSON.stringify(res.json)).toContain('with variants on');
		}
		const none = await api('PUT', '/settings/organization', body({ format: '{prefix}{tier_code}{sequence}{sep}{variant}', separator: '', variants: true }));
		expect(none.status).toBe(422);
	});

	test('variants off refuse {variant} in the format', async () => {
		const { api } = await org(OFF);
		const res = await api('PUT', '/settings/organization', body({ format: ON, variants: false }));
		expect(res.status).toBe(422);
		expect(JSON.stringify(res.json)).toContain('with variants off');
	});

	test('turning variants on keeps the stored numbers and gives new parts 001', async () => {
		const { api, create } = await org(OFF);
		const old = await create({ name: 'Old' });
		const res = await api('PUT', '/settings/organization', body({ format: ON, variants: true }));
		expect(res.status).toBe(200);
		expect(res.json.partNumbering.variants).toBe(true);
		expect((await api('GET', `/parts/${old.id}`)).json.internalPn).toBe('SPX-F-0001');
		expect((await create({ name: 'New' })).internalPn).toBe('SPX-F-0002-001');
		const preview = await api('POST', '/settings/preview-part-number', { tierLevel: 1, sequence: 7 });
		expect(preview.json.partNumber).toBe('SPX-F-0007-001');
	});
});
