import { describe, expect, test } from 'bun:test';
import { auditLog, stockMove, stockRecord } from '../../src/db/schema/index.ts';
import { today } from '../../src/services/inventory/index.ts';
import { makePart, receive, setProject, setup } from './helpers.ts';

describe('receiving stock', () => {
	test('bulk stock becomes one record with an OPAL number and one receive move', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const r = await s.call('POST', '/inventory', { partId: p.id, quantity: '12.5', location: 'A1' });
		expect(r.status).toBe(201);
		expect(r.body.items).toHaveLength(1);
		expect(r.body.items[0].opalNumber).toBe('OPAL-0001');
		expect(r.body.items[0].balance).toBe('12.5');
		expect(r.body.items[0].sourceType).toBe('manual');
		const moves = s.db.select().from(stockMove).all();
		expect(moves.map((m) => [m.kind, m.qty])).toEqual([['receive', 125000]]);
		expect(moves[0]!.actorUserId).toBe(s.admin.id);
	});

	test('serialized stock becomes one record per unit, each with its own OPAL number', async () => {
		const s = await setup();
		const p = makePart(s.db, { tracking: 'serialized' });
		const r = await s.call('POST', '/inventory', { partId: p.id, quantity: '3', location: 'A1' });
		expect(r.body.items.map((i: { opalNumber: string }) => i.opalNumber)).toEqual([
			'OPAL-0001',
			'OPAL-0002',
			'OPAL-0003'
		]);
		expect(r.body.items.every((i: { balance: string }) => i.balance === '1')).toBe(true);
	});

	test('a serialized part is received in whole units', async () => {
		const s = await setup();
		const p = makePart(s.db, { tracking: 'serialized' });
		const r = await s.call('POST', '/inventory', { partId: p.id, quantity: '1.5', location: 'A1' });
		expect(r.status).toBe(422);
		expect(r.body.fields.quantity).toBeDefined();
	});

	test('an unknown part is not found', async () => {
		const s = await setup();
		const r = await s.call('POST', '/inventory', { partId: 999, quantity: '1', location: 'A1' });
		expect(r.status).toBe(404);
	});

	test('a draft part cannot be received until it is active', async () => {
		const s = await setup();
		const p = makePart(s.db, { state: 'draft' });
		const r = await s.call('POST', '/inventory', { partId: p.id, quantity: '1', location: 'A1' });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('draft_parts_blocked');
		expect(s.db.select().from(stockRecord).all()).toHaveLength(0);
	});

	test('the quantity must be above zero', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const r = await s.call('POST', '/inventory', { partId: p.id, quantity: '0', location: 'A1' });
		expect(r.status).toBe(422);
		expect(r.body.fields.quantity).toBeDefined();
	});

	test('a tier that requires a lot refuses bulk stock without one, unless the rules are bypassed', async () => {
		const s = await setup();
		setProject(s.db, [{ level: 1, name: 'Flight', code: 'F', requireLot: true, autoSerial: false }]);
		const p = makePart(s.db, { tier: 1 });
		const body = { partId: p.id, quantity: '4', location: 'TR-1' };
		const refused = await s.call('POST', '/inventory', body);
		expect(refused.status).toBe(422);
		expect(refused.body.fields.lotNumber).toContain('lot number');
		const ok = await s.call('POST', '/inventory', { ...body, lotNumber: 'LOT-T1' });
		expect(ok.body.items[0].lotNumber).toBe('LOT-T1');
		const bypass = await s.call('POST', '/inventory', { ...body, enforceTierRules: false });
		expect(bypass.status).toBe(201);
	});

	test('a tier without the lot rule needs no lot', async () => {
		const s = await setup();
		setProject(s.db, [{ level: 3, name: 'Loose', code: 'L', requireLot: false, autoSerial: false }]);
		const p = makePart(s.db, { tier: 3 });
		expect((await s.call('POST', '/inventory', { partId: p.id, quantity: '4', location: 'A' })).status).toBe(201);
	});

	test('a tier with auto serial issues one serial per unit, and keeps a serial that was given', async () => {
		const s = await setup();
		setProject(s.db, [{ level: 1, name: 'Flight', code: 'F', requireLot: true, autoSerial: true }]);
		const p = makePart(s.db, { tier: 1, tracking: 'serialized' });
		const r = await s.call('POST', '/inventory', { partId: p.id, quantity: '3', location: 'TR-2' });
		const serials = r.body.items.map((i: { serialNumber: string }) => i.serialNumber);
		expect(serials).toEqual(['001', '002', '003']);
		const explicit = await s.call('POST', '/inventory', {
			partId: p.id,
			quantity: '1',
			location: 'TR-2',
			serialNumber: 'MY-SERIAL'
		});
		expect(explicit.body.items[0].serialNumber).toBe('MY-SERIAL');
	});

	test('one serial number cannot label several units', async () => {
		const s = await setup();
		const p = makePart(s.db, { tracking: 'serialized' });
		const r = await s.call('POST', '/inventory', {
			partId: p.id,
			quantity: '2',
			location: 'A',
			serialNumber: 'X'
		});
		expect(r.status).toBe(422);
		expect(r.body.fields.serialNumber).toBeDefined();
	});

	test('tier rules for a part are readable before receiving', async () => {
		const s = await setup();
		setProject(s.db, [{ level: 1, name: 'Flight', code: 'F', requireLot: true, autoSerial: true }]);
		const bulk = makePart(s.db, { tier: 1 });
		const ser = makePart(s.db, { tier: 1, tracking: 'serialized' });
		expect((await s.call('GET', `/inventory/receiving-rules?partId=${bulk.id}`)).body).toEqual({
			partId: bulk.id,
			requireLot: true,
			autoSerial: false,
			tierName: 'Flight'
		});
		expect((await s.call('GET', `/inventory/receiving-rules?partId=${ser.id}`)).body.autoSerial).toBe(true);
	});

	test('every move and record write leaves an audit row', async () => {
		const s = await setup();
		const p = makePart(s.db);
		await receive(s, p.id, '2');
		const entities = s.db.select().from(auditLog).all().map((a) => a.entity);
		expect(entities).toContain('stock_record');
		expect(entities).toContain('stock_move');
	});

	test('anonymous callers get 401', async () => {
		const s = await setup({ kind: 'anonymous' });
		expect((await s.call('GET', '/inventory')).status).toBe(401);
	});
});

describe('stock lists', () => {
	test('the list shows balances and filters by part and location', async () => {
		const s = await setup();
		const a = makePart(s.db, { name: 'Bolt' });
		const b = makePart(s.db, { name: 'Nut' });
		await receive(s, a.id, '5', 'SHELF-A');
		await receive(s, b.id, '7', 'SHELF-B');
		const all = await s.call('GET', '/inventory');
		expect(all.body.total).toBe(2);
		const byPart = await s.call('GET', `/inventory?partId=${a.id}`);
		expect(byPart.body.items.map((i: { balance: string }) => i.balance)).toEqual(['5']);
		const byLoc = await s.call('GET', '/inventory?location=SHELF-B');
		expect(byLoc.body.items.map((i: { partName: string }) => i.partName)).toEqual(['Nut']);
	});

	test('search matches OPAL number, part, lot and location', async () => {
		const s = await setup();
		const p = makePart(s.db, { name: 'Widget Prime' });
		await receive(s, p.id, '2', 'ZONE-9', { lotNumber: 'LOT-777' });
		for (const q of ['OPAL-0001', 'Widget', 'LOT-777', 'ZONE-9']) {
			expect((await s.call('GET', `/inventory?q=${q}`)).body.total).toBe(1);
		}
		expect((await s.call('GET', '/inventory?q=nothing')).body.total).toBe(0);
	});

	test('depleted records are hidden with hasStock and the source filter narrows by origin', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '2');
		await s.call('POST', `/inventory/${rec.id}/adjust`, { adjustment: '-2', reason: 'scrap' });
		await receive(s, p.id, '3', 'B2');
		expect((await s.call('GET', '/inventory?hasStock=true')).body.total).toBe(1);
		expect((await s.call('GET', '/inventory?hasStock=false')).body.total).toBe(1);
		expect((await s.call('GET', '/inventory?sourceType=purchase')).body.total).toBe(0);
		expect((await s.call('GET', '/inventory?sourceType=manual')).body.total).toBe(2);
	});

	test('sorting by quantity orders by balance', async () => {
		const s = await setup();
		const p = makePart(s.db);
		await receive(s, p.id, '5', 'A');
		await receive(s, p.id, '9', 'B');
		await receive(s, p.id, '1', 'C');
		const asc = await s.call('GET', '/inventory?sort=quantity&order=asc');
		expect(asc.body.items.map((i: { balance: string }) => i.balance)).toEqual(['1', '5', '9']);
		const desc = await s.call('GET', '/inventory?sort=quantity&order=desc');
		expect(desc.body.items.map((i: { balance: string }) => i.balance)).toEqual(['9', '5', '1']);
	});

	test('the list pages by cursor and reports the total', async () => {
		const s = await setup();
		const p = makePart(s.db);
		for (const loc of ['A', 'B', 'C']) await receive(s, p.id, '1', loc);
		const first = await s.call('GET', '/inventory?limit=2&sort=opalNumber');
		expect(first.body.items).toHaveLength(2);
		expect(first.body.total).toBe(3);
		const second = await s.call('GET', `/inventory?limit=2&sort=opalNumber&cursor=${first.body.next}`);
		expect(second.body.items).toHaveLength(1);
		expect(second.body.next).toBeNull();
	});

	test('low stock keeps only parts under their reorder point', async () => {
		const s = await setup();
		const low = makePart(s.db, { name: 'Low', reorderPoint: 100000 });
		const fine = makePart(s.db, { name: 'Fine', reorderPoint: 50000 });
		await receive(s, low.id, '5');
		await receive(s, fine.id, '20');
		const r = await s.call('GET', '/inventory?lowStock=true');
		expect(r.body.items.map((i: { partName: string }) => i.partName)).toEqual(['Low']);
		const q = await s.call('GET', '/inventory/low-stock');
		expect(q.body).toEqual([
			expect.objectContaining({ partId: low.id, onHand: '5', reorderPoint: '10' })
		]);
	});

	test('by part sums records and flags low stock on the whole on-hand', async () => {
		const s = await setup();
		const p = makePart(s.db, { name: 'Resistor', reorderPoint: 100000 });
		await receive(s, p.id, '4', 'A');
		await receive(s, p.id, '3', 'B');
		const all = await s.call('GET', '/inventory/by-part');
		expect(all.body.total).toBe(1);
		expect(all.body.items[0]).toMatchObject({
			name: 'Resistor',
			balance: '7',
			recordCount: 2,
			locations: ['A', 'B'],
			isLowStock: true,
			reorderPoint: '10'
		});
		// A location filter narrows the sum, not the low-stock judgement.
		const loc = await s.call('GET', '/inventory/by-part?location=A');
		expect(loc.body.items[0]).toMatchObject({ balance: '4', recordCount: 1, isLowStock: true });
	});

	test('locations list counts records and parts', async () => {
		const s = await setup();
		const a = makePart(s.db);
		const b = makePart(s.db);
		await receive(s, a.id, '1', 'BIN-1');
		await receive(s, b.id, '1', 'BIN-1');
		await receive(s, a.id, '1', 'BIN-2');
		const r = await s.call('GET', '/inventory/locations');
		expect(r.body).toEqual([
			{ location: 'BIN-1', recordCount: 2, partCount: 2 },
			{ location: 'BIN-2', recordCount: 1, partCount: 1 }
		]);
	});

	test('the attention filter matches expired and expiring stock and overdue tooling only', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const tool = makePart(s.db, { isTooling: true, calibrationIntervalDays: 365 });
		await receive(s, p.id, '1', 'A', { expirationDate: today(-3) });
		await receive(s, p.id, '1', 'B', { expirationDate: today(10) });
		await receive(s, p.id, '1', 'C', { expirationDate: today(90) });
		await receive(s, p.id, '1', 'D');
		const toolRec = await receive(s, tool.id, '1', 'T');
		await s.call('POST', `/inventory/${toolRec.id}/calibrate`);
		const rec = await s.call('GET', '/inventory?attention=true');
		expect(rec.body.items.map((i: { location: string }) => i.location).sort()).toEqual(['A', 'B']);
		expect((await s.call('GET', '/inventory?expired=true')).body.total).toBe(1);
		expect((await s.call('GET', '/inventory?expiringSoon=true')).body.total).toBe(2);
		const expiredRow = (await s.call('GET', '/inventory?expired=true')).body.items[0];
		expect(expiredRow.isExpired).toBe(true);
		expect(expiredRow.daysUntilExpiration).toBe(-3);
	});

	test('editing a record changes lot and expiry but never the quantity', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const rec = await receive(s, p.id, '4');
		const r = await s.call('PATCH', `/inventory/${rec.id}`, {
			lotNumber: 'L9',
			expirationDate: '2030-01-31',
			balance: '999',
			quantity: '999'
		});
		expect(r.body).toMatchObject({ lotNumber: 'L9', expirationDate: '2030-01-31', balance: '4' });
	});

	test('a record is found by its OPAL number', async () => {
		const s = await setup();
		const p = makePart(s.db);
		await receive(s, p.id, '4');
		expect((await s.call('GET', '/inventory/opal/OPAL-0001')).body.partId).toBe(p.id);
		expect((await s.call('GET', '/inventory/opal/OPAL-99999')).status).toBe(404);
		expect((await s.call('GET', '/inventory/9999')).status).toBe(404);
	});
});
