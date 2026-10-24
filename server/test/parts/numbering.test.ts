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

	test('a manual number is accepted and moves the counter past it', async () => {
		const { create } = await setup();
		const manual = await create({ name: 'Manual', internalPn: 'PN-1-0500' });
		expect(manual.internalPn).toBe('PN-1-0500');
		expect((await create({ name: 'Auto' })).internalPn).toBe('PN-1-0501');
	});

	test('a malformed manual number is refused with an example of the format', async () => {
		const { api } = await setup();
		const res = await api('POST', '/parts', { name: 'Bad', tier: 1, internalPn: 'WIDGET-XYZ' });
		expect(res.status).toBe(422);
		expect(res.json.message).toContain('WIDGET-XYZ');
		expect(res.json.message).toContain('PN-1-');
	});

	test('a manual number held by a deleted part is a conflict', async () => {
		const { api, create } = await setup();
		const victim = await create({ name: 'Victim' });
		await api('DELETE', `/parts/${victim.id}`);
		const res = await api('POST', '/parts', { name: 'Squatter', tier: 1, internalPn: victim.internalPn });
		expect(res.status).toBe(409);
	});

	test('a manual number held by a live part is a conflict', async () => {
		const { api, create } = await setup();
		const p = await create({ name: 'Holder' });
		expect((await api('POST', '/parts', { name: 'Twin', tier: 1, internalPn: p.internalPn })).status).toBe(409);
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
		const reuse = await api('POST', '/parts', { name: 'Reuse', tier: 1, internalPn: 'PN-1-0001' });
		expect(reuse.status).toBe(409);
	});

	test('a draft can take a new manual number', async () => {
		const { api, create } = await setup();
		const d = await create({ name: 'D' });
		const res = await api('PATCH', `/parts/${d.id}`, { internalPn: 'PN-1-0042' });
		expect(res.json.internalPn).toBe('PN-1-0042');
		expect((await create({ name: 'E' })).internalPn).toBe('PN-1-0043');
	});

	test('numbers follow the project scheme per tier', async () => {
		const { api, configureProject } = await setup();
		configureProject({
			tiers: [
				{ level: 1, name: 'Flight', code: 'F' },
				{ level: 2, name: 'Ground', code: 'G' }
			],
			part_numbering: { prefix: 'OP', separator: '/', sequence_digits: 3, format: '{prefix}{sep}{tier_code}{sep}{sequence}' }
		});
		expect((await api('GET', '/parts/next-pn?tier=2')).json).toMatchObject({ partNumber: 'OP/G/001', tierName: 'Ground' });
		expect((await api('GET', '/parts/next-pn?tier=9')).status).toBe(422);
		const bad = await api('POST', '/parts', { name: 'X', tier: 1, internalPn: 'OP/G/005' });
		expect(bad.status).toBe(422);
		expect(bad.json.message).toContain('OP/F/001');
	});
});
