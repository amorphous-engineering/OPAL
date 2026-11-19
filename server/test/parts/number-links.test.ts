import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

const TIERS = [
	{ level: 1, name: 'Flight', code: 'F' },
	{ level: 2, name: 'Ground', code: 'G' }
];

async function org(format = '{prefix}{sep}{tier_code}{sep}{sequence}', separator = '-') {
	const s = await setup();
	s.configureProject({ tiers: TIERS, part_numbering: { prefix: 'SPX', separator, sequence_digits: 4, format } });
	return s;
}

describe('a part by its number', () => {
	test('the number a person writes opens the part, at any sequence width', async () => {
		const s = await org();
		const valve = await s.create({ name: 'Valve' });
		expect(valve.internalPn).toBe('SPX-F-0001');
		for (const pn of ['SPX-F-0001', 'SPX-F-1', 'SPX-F-00001', 'SPX-F-0000000001']) {
			const r = await s.api('GET', `/parts/number/${pn}`);
			expect(r.status).toBe(200);
			expect(r.json).toMatchObject({ id: valve.id, internalPn: 'SPX-F-0001', name: 'Valve' });
		}
	});

	test('a number that names no part is not found', async () => {
		const s = await org();
		await s.create({ name: 'Valve' });
		for (const pn of ['SPX-F-0002', 'SPX-G-0001', 'valve']) {
			expect((await s.api('GET', `/parts/number/${pn}`)).status).toBe(404);
		}
	});

	test('a number with a slash in it opens the part when the slash is encoded', async () => {
		const s = await org('{prefix}{sep}{tier_code}{sep}{sequence}/{variant}');
		const valve = await s.create({ name: 'Valve' });
		expect(valve.internalPn).toBe('SPX-F-0001/001');
		const r = await s.api('GET', `/parts/number/${encodeURIComponent(valve.internalPn)}`);
		expect(r.status).toBe(200);
		expect(r.json.id).toBe(valve.id);
	});

	test('only a signed-in person may look one up', async () => {
		const s = await org();
		await s.create({ name: 'Valve' });
		expect((await s.call(null, 'GET', '/parts/number/SPX-F-0001')).status).toBe(401);
	});
});

describe('part numbers written in text', () => {
	test('each text gets the numbers in it that name a part, as written, once each', async () => {
		const s = await org();
		await s.create({ name: 'Valve' });
		await s.create({ name: 'Cart', tier: 2 });
		const r = await s.api('POST', '/parts/numbers-in', {
			texts: [
				'Fit SPX-F-0001 to the cart SPX-G-0001. Torque SPX-F-0001 again.',
				'SPX-F-0002 is not a part yet; 2026-11-17, 3-4 turns.',
				'',
				'`SPX-F-0001` in code is still a number in the text'
			]
		});
		expect(r.status).toBe(200);
		expect(r.json.found).toEqual([['SPX-F-0001', 'SPX-G-0001'], [], [], ['SPX-F-0001']]);
	});

	test('a number shorter than the shown width is not taken for a part', async () => {
		const s = await org();
		await s.create({ name: 'Valve' });
		const r = await s.api('POST', '/parts/numbers-in', { texts: ['SPX-F-1 and SPX-F-01'] });
		expect(r.json.found).toEqual([[]]);
	});

	test('a variant is found with its code, and its base alone is not a part', async () => {
		const s = await org('{prefix}{sep}{tier_code}{sep}{sequence}{sep}{variant}');
		const valve = await s.create({ name: 'Valve' });
		expect(valve.internalPn).toBe('SPX-F-0001-001');
		const r = await s.api('POST', '/parts/numbers-in', { texts: ['Fit SPX-F-0001-001, not SPX-F-0001 or SPX-F-0001-002.'] });
		expect(r.json.found).toEqual([['SPX-F-0001-001']]);
	});

	test('the batch size is bounded', async () => {
		const s = await org();
		const r = await s.api('POST', '/parts/numbers-in', { texts: Array.from({ length: 201 }, () => 'x') });
		expect(r.status).toBe(422);
	});

	test('only a signed-in person may ask', async () => {
		const s = await org();
		expect((await s.call(null, 'POST', '/parts/numbers-in', { texts: ['SPX-F-0001'] })).status).toBe(401);
	});
});
