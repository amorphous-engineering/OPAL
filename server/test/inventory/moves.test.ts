import { describe, expect, test } from 'bun:test';
import { parseQty } from '@opal/shared';
import { stockMove } from '../../src/db/schema/index.ts';
import {
	balanceOf,
	balancesForPart,
	onHandForPart,
	receiveStock
} from '../../src/services/inventory/index.ts';
import { makePart, receive, setup } from './helpers.ts';

describe('adjust', () => {
	test('found adds, damage removes, and each writes a signed move with its reason', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '10');
		const found = await s.call('POST', `/inventory/${rec.id}/adjust`, {
			adjustment: '2.5',
			reason: 'found',
			notes: 'behind shelf'
		});
		expect(found.body.balance).toBe('12.5');
		const dmg = await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '-3', reason: 'damage' });
		expect(dmg.body.balance).toBe('9.5');
		const moves = s.db.select().from(stockMove).all().filter((m) => m.kind === 'adjust');
		expect(moves.map((m) => [m.qty, m.reason, m.notes])).toEqual([
			[25000, 'found', 'behind shelf'],
			[-30000, 'damage', null]
		]);
	});

	test('found must add and damage or scrap must remove', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '10');
		const f = await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '-1', reason: 'found' });
		expect(f.status).toBe(422);
		expect(f.body.fields.adjustment).toContain('positive');
		for (const reason of ['damage', 'scrap']) {
			const r = await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '1', reason });
			expect(r.status).toBe(422);
			expect(r.body.fields.adjustment).toContain('negative');
		}
		const z = await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '0', reason: 'correction' });
		expect(z.status).toBe(422);
	});

	test('an adjustment cannot take the balance below zero', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '3');
		const r = await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '-4', reason: 'correction' });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('insufficient_stock');
		expect(balanceOf(s.ctx, rec.id)).toBe(parseQty('3'));
	});

	test('a serialized unit cannot be adjusted above one', async () => {
		const s = await setup();
		const p = makePart(s.db, { tracking: 'serialized' });
		const rec = await receive(s, p.id, '1');
		const r = await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '1', reason: 'found' });
		expect(r.status).toBe(422);
	});

	test('the cycle_count reason writes a count move', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '3');
		const r = await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '1', reason: 'cycle_count' });
		expect(r.body.balance).toBe('4');
		expect(r.body.lastCountedAt).not.toBeNull();
	});
});

describe('count', () => {
	test('a count writes the difference as a count move and stamps the count time', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '10');
		expect(rec.lastCountedAt).toBeNull();
		const r = await s.call('POST', `/inventory/${rec.id}/count`, { countedQuantity: '7' });
		expect(r.body.balance).toBe('7');
		expect(r.body.lastCountedAt).not.toBeNull();
		const m = s.db.select().from(stockMove).all().find((x) => x.kind === 'count')!;
		expect(m.qty).toBe(-30000);
	});

	test('a count that matches still goes on record', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '10');
		const r = await s.call('POST', `/inventory/${rec.id}/count`, { countedQuantity: '10' });
		expect(r.body.lastCountedAt).not.toBeNull();
		expect(s.db.select().from(stockMove).all().filter((x) => x.kind === 'count')[0]!.qty).toBe(0);
	});

	test('a count cannot be negative, and a serialized unit counts at most one', async () => {
		const s = await setup();
		const bulk = await receive(s, makePart(s.db).id, '2');
		const unit = await receive(s, makePart(s.db, { tracking: 'serialized' }).id, '1');
		expect((await s.call('POST', `/inventory/${bulk.id}/count`, { countedQuantity: '-1' })).status).toBe(422);
		expect((await s.call('POST', `/inventory/${unit.id}/count`, { countedQuantity: '2' })).status).toBe(422);
	});
});

describe('transfer', () => {
	test('a partial transfer creates a record with its own OPAL number and two paired moves', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const src = await receive(s, p.id, '10', 'A1', { lotNumber: 'L1' });
		const r = await s.call('POST', '/inventory/transfer', {
			sourceId: src.id,
			targetLocation: 'B2',
			quantity: '4'
		});
		expect(r.status).toBe(200);
		expect(r.body.source.balance).toBe('6');
		expect(r.body.target).toMatchObject({
			balance: '4',
			location: 'B2',
			lotNumber: 'L1',
			sourceType: 'transfer'
		});
		expect(r.body.target.opalNumber).not.toBe(src.opalNumber);
		const [out, inn] = s.db.select().from(stockMove).all().filter((m) => m.kind === 'transfer');
		expect([out!.qty, inn!.qty]).toEqual([-40000, 40000]);
		expect(out!.counterpartId).toBe(inn!.id);
		expect(inn!.counterpartId).toBe(out!.id);
		expect(onHandForPart(s.ctx, p.id)).toBe(parseQty('10'));
	});

	test('a whole transfer relocates the record and keeps its OPAL number', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const src = await receive(s, p.id, '5', 'A1');
		const r = await s.call('POST', '/inventory/transfer', {
			sourceId: src.id,
			targetLocation: 'C3',
			quantity: '5'
		});
		expect(r.body.target.opalNumber).toBe(src.opalNumber);
		expect(r.body.target).toMatchObject({ location: 'C3', balance: '5' });
		const m = s.db.select().from(stockMove).all().filter((x) => x.kind === 'transfer');
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ qty: 0, fromLocation: 'A1', toLocation: 'C3' });
	});

	test('a transfer merges into the stock already at the target with the same lot', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const src = await receive(s, p.id, '6', 'A1', { lotNumber: 'L1' });
		const dst = await receive(s, p.id, '2', 'B2', { lotNumber: 'L1' });
		const r = await s.call('POST', '/inventory/transfer', {
			sourceId: src.id,
			targetLocation: 'B2',
			quantity: '6'
		});
		expect(r.body.target.opalNumber).toBe(dst.opalNumber);
		expect(r.body.target.balance).toBe('8');
		expect(r.body.source.balance).toBe('0');
	});

	test('a transfer to another lot moves stock into that lot', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const src = await receive(s, p.id, '6', 'A1', { lotNumber: 'L1' });
		const r = await s.call('POST', '/inventory/transfer', {
			sourceId: src.id,
			targetLocation: 'A1',
			quantity: '2',
			targetLotNumber: 'L2'
		});
		expect(r.body.target).toMatchObject({ lotNumber: 'L2', location: 'A1', balance: '2' });
	});

	test('a serialized unit moves whole and is never split or merged', async () => {
		const s = await setup();
		const p = makePart(s.db, { tracking: 'serialized' });
		const unit = await receive(s, p.id, '1', 'A1');
		const r = await s.call('POST', '/inventory/transfer', {
			sourceId: unit.id,
			targetLocation: 'Z9',
			quantity: '1'
		});
		expect(r.body.target.opalNumber).toBe(unit.opalNumber);
		expect(r.body.target.location).toBe('Z9');
		const half = await s.call('POST', '/inventory/transfer', {
			sourceId: unit.id,
			targetLocation: 'Q',
			quantity: '0.5'
		});
		expect(half.status).toBe(422);
		expect(half.body.fields.quantity).toContain('split');
	});

	test('a transfer needs enough stock, a positive quantity and a different place', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const src = await receive(s, p.id, '3', 'A1');
		const more = await s.call('POST', '/inventory/transfer', { sourceId: src.id, targetLocation: 'B', quantity: '4' });
		expect(more.status).toBe(409);
		expect(more.body.error).toBe('insufficient_stock');
		const zero = await s.call('POST', '/inventory/transfer', { sourceId: src.id, targetLocation: 'B', quantity: '0' });
		expect(zero.status).toBe(422);
		const same = await s.call('POST', '/inventory/transfer', { sourceId: src.id, targetLocation: 'A1', quantity: '1' });
		expect(same.status).toBe(422);
		const missing = await s.call('POST', '/inventory/transfer', { sourceId: 99, targetLocation: 'B', quantity: '1' });
		expect(missing.status).toBe(404);
	});

	test('the history of an OPAL number is its ledger with a running balance', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const src = await receive(s, p.id, '10', 'A1');
		await s.call('POST', `/inventory/${src.id}/adjust`, { adjustment: '-2', reason: 'scrap' });
		await s.call('POST', '/inventory/transfer', { sourceId: src.id, targetLocation: 'B', quantity: '3' });
		const h = await s.call('GET', `/inventory/opal/${src.opalNumber}/history`);
		expect(h.body.map((r: { kind: string; qty: string; balance: string }) => [r.kind, r.qty, r.balance])).toEqual([
			['receive', '10', '10'],
			['adjust', '-2', '8'],
			['transfer', '-3', '5']
		]);
		expect(h.body[2].counterpartOpal).toMatch(/^OPAL-/);
		expect(h.body[0].actorName).toBe('Ada Admin');
	});

	test('the moves list pages the ledger across records, newest first', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const a = await receive(s, p.id, '1', 'A');
		await receive(s, p.id, '1', 'B');
		await s.call('POST', `/inventory/${a.id}/adjust`, { adjustment: '1', reason: 'found' });
		const first = await s.call('GET', '/inventory/moves?limit=2');
		expect(first.body.items.map((m: { kind: string }) => m.kind)).toEqual(['adjust', 'receive']);
		const rest = await s.call('GET', `/inventory/moves?limit=2&cursor=${first.body.next}`);
		expect(rest.body.items).toHaveLength(1);
		expect((await s.call('GET', '/inventory/moves?kind=adjust')).body.items).toHaveLength(1);
		expect((await s.call('GET', '/inventory/moves?location=B')).body.items).toHaveLength(1);
	});
});

describe('balances for other areas', () => {
	test('balanceOf, balancesForPart and onHandForPart sum the ledger', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const other = makePart(s.db);
		receiveStock(s.ctx, { partId: p.id, quantity: parseQty('4'), location: 'A' });
		receiveStock(s.ctx, { partId: p.id, quantity: parseQty('1.5'), location: 'B' });
		receiveStock(s.ctx, { partId: other.id, quantity: parseQty('9'), location: 'A' });
		expect(onHandForPart(s.ctx, p.id)).toBe(parseQty('5.5'));
		expect(balancesForPart(s.ctx, p.id).map((b) => [b.location, b.balance])).toEqual([
			['A', parseQty('4')],
			['B', parseQty('1.5')]
		]);
		expect(balanceOf(s.ctx, 1)).toBe(parseQty('4'));
	});

	test('the ledger refuses a receive with a negative quantity and a consume with a positive one', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const [rec] = receiveStock(s.ctx, { partId: p.id, quantity: parseQty('4'), location: 'A' });
		expect(() =>
			s.db.insert(stockMove).values({ stockId: rec!.id, kind: 'receive', qty: -1, at: 'x' }).run()
		).toThrow();
		expect(() =>
			s.db.insert(stockMove).values({ stockId: rec!.id, kind: 'consume', qty: 5, at: 'x' }).run()
		).toThrow();
	});

	test('a failed write leaves no partial move behind', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '3', 'A1');
		const before = s.db.select().from(stockMove).all().length;
		await s.call('POST', '/inventory/transfer', { sourceId: rec.id, targetLocation: 'B', quantity: '9' });
		expect(s.db.select().from(stockMove).all().length).toBe(before);
	});
});
