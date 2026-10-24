import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { part } from '../../src/db/schema/index.ts';
import { ensureFts, ftsStatements, registerSearchable } from '../../src/services/platform/search.ts';
import { setup } from './helpers.ts';

registerSearchable({
	type: 'part',
	table: part,
	columns: [part.name, part.internalPn, part.externalPn, part.description],
	identifier: part.internalPn,
	where: eq(part.state, 'draft'),
	hit: (r) => ({ label: r.name, sublabel: r.internalPn, href: `/parts/${r.id}`, status: r.state })
});

const base = { unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 1 } as const;

async function withIndex() {
	const s = await setup();
	ensureFts(s.db);
	return s;
}

describe('search', () => {
	test('finds a substring of a registered column through the FTS index', async () => {
		const s = await withIndex();
		s.db.insert(part).values({ ...base, internalPn: 'PN-OSC-1', name: 'Oscillator Crystal', createdAt: 'x', updatedAt: 'x' }).run();
		s.db.insert(part).values({ ...base, internalPn: 'PN-2', name: 'Bolt', createdAt: 'x', updatedAt: 'x' }).run();
		const hits = await (await s.call('GET', '/search?q=scillat')).json();
		expect(hits).toEqual([{ entityType: 'part', id: 1, label: 'Oscillator Crystal', sublabel: 'PN-OSC-1', href: '/parts/1', status: 'draft' }]);
	});

	test('the index follows inserts, updates and deletes', async () => {
		const s = await withIndex();
		s.db.insert(part).values({ ...base, internalPn: 'P-1', name: 'Flux Capacitor', createdAt: 'x', updatedAt: 'x' }).run();
		const q = async (t: string) => (await (await s.call('GET', `/search?q=${t}`)).json()).length;
		expect(await q('capacitor')).toBe(1);
		s.db.update(part).set({ name: 'Warp Coil' }).where(eq(part.id, 1)).run();
		expect(await q('capacitor')).toBe(0);
		expect(await q('warp')).toBe(1);
		s.db.delete(part).where(eq(part.id, 1)).run();
		expect(await q('warp')).toBe(0);
	});

	test('rows the registration excludes do not appear', async () => {
		const s = await withIndex();
		s.db.insert(part).values({ ...base, internalPn: 'P-1', name: 'Oscillator Mk1', state: 'obsolete', createdAt: 'x', updatedAt: 'x' }).run();
		s.db.insert(part).values({ ...base, internalPn: 'P-2', name: 'Oscillator Mk2', createdAt: 'x', updatedAt: 'x' }).run();
		const hits = await (await s.call('GET', '/search?q=oscillator')).json();
		expect(hits.map((h: { label: string }) => h.label)).toEqual(['Oscillator Mk2']);
	});

	test('a query shorter than three characters falls back to LIKE', async () => {
		const s = await withIndex();
		s.db.insert(part).values({ ...base, internalPn: 'P-1', name: 'Oscillator', createdAt: 'x', updatedAt: 'x' }).run();
		expect(await (await s.call('GET', '/search?q=os')).json()).toHaveLength(1);
	});

	test('without the index the search still works through LIKE', async () => {
		const s = await setup();
		s.db.insert(part).values({ ...base, internalPn: 'P-1', name: 'Oscillator', createdAt: 'x', updatedAt: 'x' }).run();
		expect(await (await s.call('GET', '/search?q=oscill')).json()).toHaveLength(1);
	});

	test('records whose identifier matches come first', async () => {
		const s = await withIndex();
		s.db.insert(part).values({ ...base, internalPn: 'P-1', name: 'Has widget-7 in name', createdAt: 'x', updatedAt: 'x' }).run();
		s.db.insert(part).values({ ...base, internalPn: 'WIDGET-7', name: 'Plain', createdAt: 'x', updatedAt: 'x' }).run();
		const hits = await (await s.call('GET', '/search?q=widget-7')).json();
		expect(hits[0].sublabel).toBe('WIDGET-7');
	});

	test('the limit applies per entity type', async () => {
		const s = await withIndex();
		for (let i = 0; i < 4; i++) s.db.insert(part).values({ ...base, internalPn: `P-${i}`, name: `Washer ${i}`, createdAt: 'x', updatedAt: 'x' }).run();
		expect(await (await s.call('GET', '/search?q=washer&limit=2')).json()).toHaveLength(2);
	});

	test('quotes and percent signs in the query are literal text', async () => {
		const s = await withIndex();
		s.db.insert(part).values({ ...base, internalPn: 'P-1', name: '50% duty "fast"', createdAt: 'x', updatedAt: 'x' }).run();
		expect(await (await s.call('GET', '/search?q=%22fast%22')).json()).toHaveLength(1);
		expect(await (await s.call('GET', '/search?q=50%25')).json()).toHaveLength(1);
		expect(await (await s.call('GET', '/search?q=%25%25%25')).json()).toHaveLength(0);
	});

	test('the migration statements are idempotent and cover every registered table', async () => {
		const s = await setup();
		const stmts = ftsStatements();
		expect(stmts.some((x) => x.includes('CREATE VIRTUAL TABLE IF NOT EXISTS part_fts'))).toBe(true);
		ensureFts(s.db);
		ensureFts(s.db);
	});

	test('anonymous callers get 401', async () => {
		const s = await setup();
		s.setActor({ kind: 'anonymous' });
		expect((await s.call('GET', '/search?q=abc')).status).toBe(401);
	});
});
