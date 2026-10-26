import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

describe('part numbering', () => {
	test('a deleted part never gives its number back', async () => {
		const { api, create } = await setup();
		const a = await create({ name: 'A' });
		const b = await create({ name: 'B' });
		expect([a.internalPn, b.internalPn]).toEqual(['PN-1-0001', 'PN-1-0002']);
		expect((await api('DELETE', `/parts/${b.id}`)).status).toBe(200);
		const c = await create({ name: 'C' });
		expect(c.internalPn).toBe('PN-1-0003');
		expect((await api('GET', '/parts/next-pn?tier=1')).json.partNumber).toBe('PN-1-0004');
	});

	test('the next-number preview does not use the number up', async () => {
		const { api, create } = await setup();
		const first = (await api('GET', '/parts/next-pn?tier=1')).json;
		const second = (await api('GET', '/parts/next-pn?tier=1')).json;
		expect(first).toEqual(second);
		expect(first.defaultTracking).toBe('serialized');
		const part = await create({ name: 'Consumer' });
		expect(part.internalPn).toBe(first.partNumber);
		const after = (await api('GET', '/parts/next-pn?tier=1')).json;
		expect(after.sequence).toBe(first.sequence + 1);
	});

	test('reserve creates contiguous draft parts and the next number follows the block', async () => {
		const { api, create } = await setup();
		const res = await api('POST', '/parts/reserve', { tier: 2, count: 5 });
		expect(res.status).toBe(200);
		expect(res.json.parts.map((p: any) => p.internalPn)).toEqual([1, 2, 3, 4, 5].map((i) => `PN-2-000${i}`));
		expect(res.json.parts.every((p: any) => p.name.startsWith('RESERVED-') && p.state === 'draft')).toBe(true);
		expect([res.json.firstPn, res.json.lastPn]).toEqual(['PN-2-0001', 'PN-2-0005']);
		expect((await create({ name: 'After', tier: 2 })).internalPn).toBe('PN-2-0006');
	});

	test('reserve refuses a count of zero or above 500', async () => {
		const { api } = await setup();
		expect((await api('POST', '/parts/reserve', { tier: 2, count: 0 })).status).toBe(422);
		expect((await api('POST', '/parts/reserve', { tier: 2, count: 501 })).status).toBe(422);
	});

	test('a draft tier change takes a fresh number and abandons the old one for good', async () => {
		const { api, create } = await setup();
		const draft = await create({ name: 'Mover' });
		expect(draft.internalPn).toBe('PN-1-0001');
		const moved = (await api('PATCH', `/parts/${draft.id}`, { tier: 2 })).json;
		expect(moved.tier).toBe(2);
		expect(moved.internalPn).toBe('PN-2-0001');
		expect((await create({ name: 'Next tier 1' })).internalPn).toBe('PN-1-0002');
		expect((await api('GET', '/parts/next-pn?tier=1')).json.partNumber).toBe('PN-1-0003');
	});

	test('numbers follow the project scheme per tier', async () => {
		const { api, create, configureProject } = await setup();
		configureProject({
			tiers: [
				{ level: 1, name: 'Flight', code: 'F' },
				{ level: 2, name: 'Ground', code: 'G' }
			],
			part_numbering: { prefix: 'OP', separator: '/', sequence_digits: 3, format: '{prefix}{sep}{tier_code}{sep}{sequence}' }
		});
		expect((await api('GET', '/parts/next-pn?tier=2')).json).toMatchObject({ partNumber: 'OP/G/001', tierName: 'Ground' });
		expect((await api('GET', '/parts/next-pn?tier=9')).status).toBe(422);
		expect((await create({ name: 'X', tier: 1 })).internalPn).toBe('OP/F/001');
	});

	test('a part number cannot be chosen at create', async () => {
		const { api, create, db } = await setup();
		const a = await create({ name: 'A', internalPn: 'PN-1-0500' });
		expect(a.internalPn).toBe('PN-1-0001');
		const res = await api('POST', '/parts/bulk', { parts: [{ name: 'B', internalPn: 'PN-1-0050' }] });
		expect(res.json.parts[0].internalPn).toBe('PN-1-0002');
		const stored = db.$client.query('select internal_pn from part where id = ?').get(a.id) as any;
		expect(stored.internal_pn).toBe('PN-1-0000000001');
		expect((await api('GET', '/parts/next-pn?tier=1')).json.partNumber).toBe('PN-1-0003');
	});

	test('a part number cannot be changed by an update', async () => {
		const { api, create } = await setup();
		const d = await create({ name: 'D' });
		const res = await api('PATCH', `/parts/${d.id}`, { internalPn: 'PN-1-0042', name: 'D2' });
		expect(res.json).toMatchObject({ internalPn: 'PN-1-0001', name: 'D2' });
		expect((await create({ name: 'E' })).internalPn).toBe('PN-1-0002');
	});
});
