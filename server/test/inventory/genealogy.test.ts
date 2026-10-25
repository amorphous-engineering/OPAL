import { numbersFor } from '../../src/services/org/project.ts';
import { describe, expect, test } from 'bun:test';
import { parseQty } from '@opal/shared';
import { stockMove } from '../../src/db/schema/index.ts';
import {
	balanceOf,
	calibrationReport,
	consumeStock,
	createStockRecord,
	expiringStock,
	linkComponents,
	lowStockParts,
	produceStock,
	receiveStock
} from '../../src/services/inventory/index.ts';
import { makePart, receive, setup } from './helpers.ts';

const q = parseQty;

describe('consume and produce', () => {
	test('consuming removes stock and refuses to overdraw', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const [rec] = receiveStock(s.ctx, { partId: p.id, quantity: q('5'), location: 'A' });
		consumeStock(s.ctx, { stockId: rec!.id, quantity: q('2') });
		expect(balanceOf(s.ctx, rec!.id)).toBe(q('3'));
		expect(() => consumeStock(s.ctx, { stockId: rec!.id, quantity: q('4') })).toThrow(/below zero/);
		expect(balanceOf(s.ctx, rec!.id)).toBe(q('3'));
	});

	test('tooling use writes a consume move of zero and keeps the balance', async () => {
		const s = await setup();
		const p = makePart(s.db, { isTooling: true });
		const [rec] = receiveStock(s.ctx, { partId: p.id, quantity: q('1'), location: 'A' });
		const m = consumeStock(s.ctx, { stockId: rec!.id, quantity: q('0'), tooling: true });
		expect(m).toMatchObject({ kind: 'consume', qty: 0, reason: 'tooling' });
		expect(balanceOf(s.ctx, rec!.id)).toBe(q('1'));
	});

	test('producing creates a record with an OPAL number and a produce move', async () => {
		const s = await setup();
		const asm = makePart(s.db, { name: 'Assembly' });
		const r = produceStock(s.ctx, { partId: asm.id, quantity: q('1'), location: 'WIP', serialNumber: '007' });
		expect(r.stock).toMatchObject({ sourceType: 'production', balance: '1', serialNumber: '007' });
		const move = s.db.select().from(stockMove).all().find((m) => m.id === r.moveId)!;
		expect(move.kind).toBe('produce');
	});

	test('producing into a record made ahead keeps the OPAL number reserved earlier', async () => {
		const s = await setup();
		const asm = makePart(s.db);
		const reserved = createStockRecord(s.ctx, {
			partId: asm.id,
			location: 'WIP',
			sourceType: 'production'
		});
		const r = produceStock(s.ctx, { stockId: reserved.id, quantity: q('1') });
		expect(r.stock.opalNumber).toBe(reserved.opalNumber);
		expect(r.stock.balance).toBe('1');
	});

	test('a draft part cannot be produced', async () => {
		const s = await setup();
		const asm = makePart(s.db, { state: 'draft' });
		expect(() => produceStock(s.ctx, { partId: asm.id, quantity: q('1'), location: 'W' })).toThrow(/draft/);
	});
});

describe('genealogy', () => {
	function build() {
		return setup().then((s) => {
			const screw = makePart(s.db, { name: 'Screw' });
			const plate = makePart(s.db, { name: 'Plate' });
			const sub = makePart(s.db, { name: 'Subassembly' });
			const top = makePart(s.db, { name: 'Top assembly' });
			const [screws] = receiveStock(s.ctx, { partId: screw.id, quantity: q('20'), location: 'A' });
			const [plates] = receiveStock(s.ctx, { partId: plate.id, quantity: q('5'), location: 'A' });
			const c1 = consumeStock(s.ctx, { stockId: screws!.id, quantity: q('4') });
			const c2 = consumeStock(s.ctx, { stockId: plates!.id, quantity: q('1') });
			const built = produceStock(s.ctx, {
				partId: sub.id,
				quantity: q('1'),
				location: 'WIP',
				componentMoveIds: [c1.id, c2.id]
			});
			const c3 = consumeStock(s.ctx, { stockId: built.stock.id, quantity: q('1') });
			const c4 = consumeStock(s.ctx, { stockId: screws!.id, quantity: q('2') });
			const final = produceStock(s.ctx, {
				partId: top.id,
				quantity: q('1'),
				location: 'WIP',
				componentMoveIds: [c3.id, c4.id]
			});
			return { s, screws: screws!, plates: plates!, sub: built.stock, top: final.stock, c4 };
		});
	}

	test('the components of an assembly are the consume moves linked to it, summed per record', async () => {
		const { s, sub, screws } = await build();
		const d = numbersFor(s.db).display;
		const r = await s.call('GET', `/inventory/opal/${sub.opalNumber}/genealogy`);
		expect(r.body.components.map((c: { opalNumber: string; qtyUsed: string; partName: string }) => [c.opalNumber, c.partName, c.qtyUsed])).toEqual([
			[d(screws.opalNumber), 'Screw', '4'],
			[expect.any(String), 'Plate', '1']
		]);
		expect(r.body.components.every((c: { viaOpal: string; depth: number }) => c.viaOpal === d(sub.opalNumber) && c.depth === 1)).toBe(true);
	});

	test('where used lists the assemblies an item went into, and depth follows the tree', async () => {
		const { s, screws, top, sub } = await build();
		const d = numbersFor(s.db).display;
		const direct = await s.call('GET', `/inventory/opal/${screws.opalNumber}/genealogy`);
		expect(direct.body.usedIn.map((a: { opalNumber: string; qtyUsed: string }) => [a.opalNumber, a.qtyUsed])).toEqual([
			[d(sub.opalNumber), '4'],
			[d(top.opalNumber), '2']
		]);
		const deep = await s.call('GET', `/inventory/opal/${top.opalNumber}/genealogy?depth=3`);
		const byDepth = deep.body.components.map((c: { depth: number; partName: string }) => [c.depth, c.partName]);
		expect(byDepth).toEqual([
			[1, 'Subassembly'],
			[1, 'Screw'],
			[2, 'Screw'],
			[2, 'Plate']
		]);
		const up = await s.call('GET', `/inventory/opal/${screws.opalNumber}/genealogy?depth=2`);
		expect(up.body.usedIn.map((a: { depth: number; partName: string }) => [a.depth, a.partName])).toEqual([
			[1, 'Subassembly'],
			[1, 'Top assembly'],
			[2, 'Top assembly']
		]);
	});

	test('a consume move links to one assembly only', async () => {
		const { s, sub, top, c4 } = await build();
		expect(() => linkComponents(s.ctx, sub.id, [c4.id])).toThrow(/already went into/);
		// Linking again to the same assembly is a no-op.
		linkComponents(s.ctx, top.id, [c4.id]);
	});

	test('only consume moves can be components', async () => {
		const { s, sub } = await build();
		const receiveMove = s.db.select().from(stockMove).all().find((m) => m.kind === 'receive')!;
		expect(() => linkComponents(s.ctx, sub.id, [receiveMove.id])).toThrow();
	});

	test('the record page carries ledger, source, genealogy both ways, and tests', async () => {
		const { s, sub, screws } = await build();
		const d = await s.call('GET', `/inventory/opal/${sub.opalNumber}/detail`);
		expect(d.status).toBe(200);
		expect(d.body.source.type).toBe('production');
		expect(d.body.components).toHaveLength(2);
		expect(d.body.usedIn).toHaveLength(1);
		expect(d.body.ledger.map((r: { kind: string }) => r.kind)).toEqual(['produce', 'consume']);
		expect(d.body.record.balance).toBe('0');
		const c = await s.call('GET', `/inventory/opal/${screws.opalNumber}/detail`);
		expect(c.body.source.type).toBe('manual');
		expect(c.body.part.name).toBe('Screw');
		expect((await s.call('GET', '/inventory/opal/NOPE/detail')).status).toBe(404);
	});
});

describe('attention queries for the overview', () => {
	test('calibration report splits tooling into overdue and due soon', async () => {
		const s = await setup();
		const p = makePart(s.db, { isTooling: true, calibrationIntervalDays: 20 });
		const late = await receive(s, p.id, '1', 'T1');
		const soon = await receive(s, p.id, '1', 'T2');
		const far = makePart(s.db, { isTooling: true, calibrationIntervalDays: 365 });
		const fine = await receive(s, far.id, '1', 'T3');
		for (const r of [soon, fine]) await s.call('POST', `/inventory/${r.id}/calibrate`);
		// Push one record's due date into the past.
		const { stockRecord } = await import('../../src/db/schema/index.ts');
		const { eq } = await import('drizzle-orm');
		s.db.update(stockRecord).set({ calibrationDueAt: '2020-01-01T00:00:00.000Z' }).where(eq(stockRecord.id, late.id)).run();
		const rep = calibrationReport(s.ctx);
		expect(rep.overdue.map((r) => r.location)).toEqual(['T1']);
		expect(rep.dueSoon.map((r) => r.location)).toEqual(['T2']);
		expect(rep.overdue[0]!.calibrationStatus).toBe('overdue');
		const api = await s.call('GET', '/inventory/calibration');
		expect(api.body.overdue).toHaveLength(1);
	});

	test('calibrating sets the due date from the part interval, and needs a tooling part', async () => {
		const s = await setup();
		const tool = makePart(s.db, { isTooling: true, calibrationIntervalDays: 365 });
		const plain = makePart(s.db);
		const noInterval = makePart(s.db, { isTooling: true });
		const t = await receive(s, tool.id, '1');
		const r = await s.call('POST', `/inventory/${t.id}/calibrate`);
		expect(r.body.lastCalibratedAt).not.toBeNull();
		const days = (Date.parse(r.body.calibrationDueAt) - Date.parse(r.body.lastCalibratedAt)) / 86_400_000;
		expect(Math.round(days)).toBe(365);
		expect(r.body.calibrationStatus).toBe('ok');
		const x = await receive(s, plain.id, '1');
		expect((await s.call('POST', `/inventory/${x.id}/calibrate`)).status).toBe(422);
		const n = await receive(s, noInterval.id, '1');
		expect((await s.call('POST', `/inventory/${n.id}/calibrate`)).body.calibrationDueAt).toBeNull();
	});

	test('expiring stock lists on-hand stock that is expired or expires within 30 days', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const { today } = await import('../../src/services/inventory/index.ts');
		await receive(s, p.id, '1', 'EXPIRED', { expirationDate: today(-1) });
		await receive(s, p.id, '1', 'SOON', { expirationDate: today(5) });
		await receive(s, p.id, '1', 'LATER', { expirationDate: today(200) });
		const empty = await receive(s, p.id, '1', 'GONE', { expirationDate: today(-1) });
		await s.call('POST', `/inventory/${empty.id}/adjust`, { adjustment: '-1', reason: 'scrap' });
		expect(expiringStock(s.ctx).map((r) => r.location)).toEqual(['EXPIRED', 'SOON']);
	});

	test('low stock parts report on-hand against the reorder point', async () => {
		const s = await setup();
		const p = makePart(s.db, { reorderPoint: 100000, name: 'Gasket' });
		await receive(s, p.id, '3');
		expect(lowStockParts(s.ctx)).toEqual([
			{ partId: p.id, internalPn: p.internalPn, name: 'Gasket', unitOfMeasure: 'ea', onHand: '3', reorderPoint: '10' }
		]);
	});

	test('the part summary totals records and reports tooling calibration', async () => {
		const s = await setup();
		const tool = makePart(s.db, { isTooling: true, calibrationIntervalDays: 30 });
		const a = await receive(s, tool.id, '1', 'A');
		await receive(s, tool.id, '1', 'B');
		await s.call('POST', `/inventory/${a.id}/calibrate`);
		const r = await s.call('GET', `/inventory/parts/${tool.id}/summary`);
		expect(r.body).toMatchObject({ totalQty: '2', recordCount: 2, isTooling: true, calibrationStatus: 'ok' });
		expect(r.body.byLocation.map((l: { location: string }) => l.location)).toEqual(['A', 'B']);
	});
});
