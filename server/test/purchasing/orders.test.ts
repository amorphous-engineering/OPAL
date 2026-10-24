import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditLog, stockMove, stockRecord } from '../../src/db/schema/index.ts';
import { makePart, mkPo, mkSupplier, orderedPo, recv, setProject, setStatus, setup } from './helpers.ts';

describe('creating a purchase order', () => {
	test('references are generated in sequence as PO-NNNN', async () => {
		const s = await setup();
		expect((await mkPo(s)).reference).toBe('PO-0001');
		expect((await mkPo(s)).reference).toBe('PO-0002');
	});

	test('a registered supplier gives its name to the order', async () => {
		const s = await setup();
		const sup = await mkSupplier(s, 'Registered Co');
		const r = await s.call('POST', '/purchases', { supplierId: sup.id });
		expect(r.status).toBe(201);
		expect(r.body.supplierName).toBe('Registered Co');
		expect(r.body.status).toBe('draft');
	});

	test('an order needs a supplier or a supplier name', async () => {
		const s = await setup();
		expect((await s.call('POST', '/purchases', {})).status).toBe(422);
	});

	test('a duplicate reference is refused on create and on update', async () => {
		const s = await setup();
		await mkPo(s, { reference: 'PO-X' });
		const dup = await s.call('POST', '/purchases', { supplierName: 'A', reference: 'PO-X' });
		expect(dup.status).toBe(409);
		const other = await mkPo(s);
		expect((await s.call('PATCH', `/purchases/${other.id}`, { reference: 'PO-X' })).status).toBe(409);
	});

	test('a draft part cannot be put on an order, on create or by adding a line', async () => {
		const s = await setup();
		const draft = makePart(s.db, { state: 'draft' });
		const r = await s.call('POST', '/purchases', { supplierName: 'A', lines: [{ partId: draft.id, qtyOrdered: '1' }] });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('draft_parts_blocked');
		const po = await mkPo(s);
		const add = await s.call('POST', `/purchases/${po.id}/lines`, { partId: draft.id, qtyOrdered: '1' });
		expect(add.body.error).toBe('draft_parts_blocked');
	});

	test('create writes an audit row for the order and each line', async () => {
		const s = await setup();
		const p = makePart(s.db);
		await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '2' }] });
		const rows = s.db.select().from(auditLog).all().map((a) => a.entity);
		expect(rows).toContain('purchase');
		expect(rows).toContain('purchase_line');
	});
});

describe('status workflow', () => {
	test('placing an order needs a line', async () => {
		const s = await setup();
		const po = await mkPo(s);
		expect((await setStatus(s, po.id, 'ordered')).status).toBe(409);
	});

	test('draft, ordered, on hold and cancelled follow the allowed transitions; cancelled is final', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '2' }] });
		const placed = await setStatus(s, po.id, 'ordered');
		expect(placed.body.orderedAt).not.toBeNull();
		expect((await setStatus(s, po.id, 'on_hold')).body.status).toBe('on_hold');
		expect((await setStatus(s, po.id, 'ordered')).body.status).toBe('ordered');
		const back = await setStatus(s, po.id, 'draft');
		expect(back.body.status).toBe('draft');
		expect(back.body.orderedAt).toBeNull();
		expect((await setStatus(s, po.id, 'cancelled')).body.status).toBe('cancelled');
		expect((await setStatus(s, po.id, 'ordered')).status).toBe(409);
	});

	test('received and partial cannot be set by hand', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '1');
		expect((await setStatus(s, po.id, 'received')).status).toBe(409);
		expect((await setStatus(s, po.id, 'partial')).status).toBe(409);
	});

	test('a cancelled order can only have its notes edited', async () => {
		const s = await setup();
		const po = await mkPo(s);
		await setStatus(s, po.id, 'cancelled');
		expect((await s.call('PATCH', `/purchases/${po.id}`, { notes: 'why' })).status).toBe(200);
		expect((await s.call('PATCH', `/purchases/${po.id}`, { destination: 'X' })).status).toBe(409);
	});

	test('an order is overdue when its target date has passed and it is not received or cancelled', async () => {
		const s = await setup();
		const late = await mkPo(s, { targetDate: '2020-01-01' });
		expect(late.isOverdue).toBe(true);
		await setStatus(s, late.id, 'cancelled');
		expect((await s.call('GET', `/purchases/${late.id}`)).body.isOverdue).toBe(false);
		expect((await mkPo(s, { targetDate: '2999-01-01' })).isOverdue).toBe(false);
	});
});

describe('lines', () => {
	test('lines can be added, edited and removed while the order is open', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await mkPo(s);
		const add = await s.call('POST', `/purchases/${po.id}/lines`, {
			partId: p.id,
			qtyOrdered: '5',
			unitCost: '2',
			destination: 'Bin 4'
		});
		expect(add.status).toBe(200);
		expect(add.body.destination).toBe('Bin 4');
		expect(add.body.partInternalPn).toBe(p.internalPn);
		const upd = await s.call('PATCH', `/purchases/${po.id}/lines/${add.body.id}`, { qtyOrdered: '8' });
		expect(upd.body.qtyOrdered).toBe('8');
		expect((await s.call('POST', `/purchases/${po.id}/lines`, { partId: p.id, qtyOrdered: '0' })).status).toBe(422);
		expect((await s.call('DELETE', `/purchases/${po.id}/lines/${add.body.id}`)).status).toBe(200);
		expect((await s.call('GET', `/purchases/${po.id}`)).body.lines).toEqual([]);
	});

	test('quantity cannot drop below what arrived, cost and deletion lock, and lowering to the received quantity completes the order', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await orderedPo(s, p.id, '10');
		const lineId = po.lines[0].id;
		await recv(s, po.id, [{ lineId, quantity: '4', location: 'A' }]);
		const base = `/purchases/${po.id}/lines/${lineId}`;
		expect((await s.call('PATCH', base, { qtyOrdered: '3' })).status).toBe(422);
		expect((await s.call('PATCH', base, { unitCost: '9' })).status).toBe(422);
		expect((await s.call('DELETE', base)).status).toBe(409);
		expect((await s.call('PATCH', base, { qtyOrdered: '4' })).status).toBe(200);
		expect((await s.call('GET', `/purchases/${po.id}`)).body.status).toBe('received');
	});

	test('lines of a cancelled order cannot change', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '1' }] });
		await setStatus(s, po.id, 'cancelled');
		expect((await s.call('POST', `/purchases/${po.id}/lines`, { partId: p.id, qtyOrdered: '1' })).status).toBe(409);
	});

	test('the total cost is the sum of cost times quantity over the lines that have a cost', async () => {
		const s = await setup();
		const a = makePart(s.db);
		const b = makePart(s.db);
		const po = await mkPo(s, {
			lines: [
				{ partId: a.id, qtyOrdered: '2', unitCost: '1.25' },
				{ partId: b.id, qtyOrdered: '3' }
			]
		});
		expect(po.totalCost).toBe('2.5');
		expect((await mkPo(s)).totalCost).toBeNull();
	});
});

describe('receiving', () => {
	test('the location falls back to the order destination, the full receipt closes the order and links the stock move to the line', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await mkPo(s, { destination: 'Dock', lines: [{ partId: p.id, qtyOrdered: '3', unitCost: '1.50' }] });
		await setStatus(s, po.id, 'ordered');
		const lineId = po.lines[0].id;
		const r = await recv(s, po.id, [{ lineId, quantity: '3', lotNumber: 'L1' }]);
		expect(r.status).toBe(200);
		expect(r.body.status).toBe('received');
		expect(r.body.receivedById).toBe(s.admin.id);
		expect(r.body.receivedAt).not.toBeNull();
		expect(r.body.lines[0].qtyReceived).toBe('3');
		const recs = (await s.call('GET', `/purchases/${po.id}/inventory`)).body;
		expect(recs).toHaveLength(1);
		expect(recs[0]).toMatchObject({ location: 'Dock', lotNumber: 'L1', purchaseLineId: lineId, quantity: '3' });
		expect(recs[0].opalNumber).toMatch(/^OPAL-/);
		const move = s.db.select().from(stockMove).where(eq(stockMove.purchaseLineId, lineId)).get();
		expect(move?.kind).toBe('receive');
		const rec = s.db.select().from(stockRecord).where(eq(stockRecord.id, move!.stockId)).get();
		expect(rec?.sourceType).toBe('purchase');
	});

	test('a partial receipt makes the order partial and a second one completes it', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '4');
		const lineId = po.lines[0].id;
		const a = await recv(s, po.id, [{ lineId, quantity: '1', location: 'A' }]);
		expect(a.body.status).toBe('partial');
		expect(a.body.lines[0].qtyOutstanding).toBe('3');
		const b = await recv(s, po.id, [{ lineId, quantity: '3', location: 'A' }]);
		expect(b.body.status).toBe('received');
	});

	test('receiving without any location is refused', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '1');
		const r = await recv(s, po.id, [{ lineId: po.lines[0].id, quantity: '1' }]);
		expect(r.status).toBe(422);
		expect(r.body.fields.location).toBeDefined();
	});

	test('a serialized part is received in whole units, one stock record each', async () => {
		const s = await setup();
		const p = makePart(s.db, { tracking: 'serialized' });
		const po = await orderedPo(s, p.id, '3');
		const lineId = po.lines[0].id;
		expect((await recv(s, po.id, [{ lineId, quantity: '1.5', location: 'A' }])).status).toBe(422);
		const ok = await recv(s, po.id, [{ lineId, quantity: '2', location: 'A' }]);
		expect(ok.body.status).toBe('partial');
		expect((await s.call('GET', `/purchases/${po.id}/inventory`)).body).toHaveLength(2);
	});

	test('a tier that requires a lot refuses a bulk receipt without one, and the line says so', async () => {
		const s = await setup();
		setProject(s.db, [{ level: 2, name: 'Lot', code: 'L', requireLot: true, autoSerial: false }]);
		const p = makePart(s.db, { tier: 2 });
		const po = await orderedPo(s, p.id, '2');
		expect(po.lines[0].lotRequired).toBe(true);
		const lineId = po.lines[0].id;
		const refused = await recv(s, po.id, [{ lineId, quantity: '1', location: 'A' }]);
		expect(refused.status).toBe(422);
		expect(refused.body.fields.lotNumber).toContain('lot number');
		expect((await recv(s, po.id, [{ lineId, quantity: '1', location: 'A', lotNumber: 'L9' }])).status).toBe(200);
	});

	test('a tier with auto serial issues unique serials per unit, and a typed number is kept for one unit', async () => {
		const s = await setup();
		setProject(s.db, [{ level: 1, name: 'Flight', code: 'F', requireLot: false, autoSerial: true }]);
		const p = makePart(s.db, { tier: 1, tracking: 'serialized' });
		const po = await orderedPo(s, p.id, '4');
		const lineId = po.lines[0].id;
		await recv(s, po.id, [{ lineId, quantity: '3', location: 'A' }]);
		await recv(s, po.id, [{ lineId, quantity: '1', location: 'A', lotNumber: 'SN-MINE' }]);
		const serials = (await s.call('GET', `/purchases/${po.id}/inventory`)).body.map((r: { serialNumber: string }) => r.serialNumber);
		expect(serials).toEqual(['001', '002', '003', 'SN-MINE']);
	});

	test('more than the outstanding quantity is refused until confirmed, and nothing is written when refused', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		const lineId = po.lines[0].id;
		const refused = await recv(s, po.id, [{ lineId, quantity: '4', location: 'Bin Z' }]);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('over_receipt');
		expect(refused.body.message).toContain('exceeds the 3 outstanding');
		expect(s.db.select().from(stockMove).all()).toHaveLength(0);
		expect((await s.call('GET', `/purchases/${po.id}`)).body.status).toBe('ordered');
		const ok = await recv(s, po.id, [{ lineId, quantity: '4', location: 'Bin Z', allowOverReceipt: true }]);
		expect(ok.body.status).toBe('received');
		expect(ok.body.lines[0].qtyReceived).toBe('4');
	});

	test('earlier receipts count against the outstanding quantity', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		const lineId = po.lines[0].id;
		const one = (q: string) => recv(s, po.id, [{ lineId, quantity: q, location: 'Bin Z' }]).then((r) => r.status);
		expect(await one('2')).toBe(200);
		expect(await one('2')).toBe(409);
		expect(await one('1')).toBe(200);
	});

	test('a failed line rolls the whole receipt back', async () => {
		const s = await setup();
		const a = makePart(s.db);
		const b = makePart(s.db);
		const po = await mkPo(s, {
			lines: [
				{ partId: a.id, qtyOrdered: '1' },
				{ partId: b.id, qtyOrdered: '1' }
			]
		});
		await setStatus(s, po.id, 'ordered');
		const r = await recv(s, po.id, [
			{ lineId: po.lines[0].id, quantity: '1', location: 'A' },
			{ lineId: po.lines[1].id, quantity: '5', location: 'A' }
		]);
		expect(r.status).toBe(409);
		expect(s.db.select().from(stockMove).all()).toHaveLength(0);
	});

	test('a line can appear only once per receipt', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		const lineId = po.lines[0].id;
		const r = await recv(s, po.id, [
			{ lineId, quantity: '1', location: 'A' },
			{ lineId, quantity: '1', location: 'A' }
		]);
		expect(r.status).toBe(422);
	});

	test('an order on hold takes no deliveries, and resuming it restores partial', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '4');
		const lineId = po.lines[0].id;
		await recv(s, po.id, [{ lineId, quantity: '1', location: 'A' }]);
		expect((await setStatus(s, po.id, 'on_hold')).status).toBe(200);
		expect((await recv(s, po.id, [{ lineId, quantity: '1', location: 'A' }])).status).toBe(409);
		expect((await setStatus(s, po.id, 'ordered')).body.status).toBe('partial');
	});

	test('a part that became a draft again cannot be received', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await orderedPo(s, p.id, '1');
		const { part } = await import('../../src/db/schema/index.ts');
		s.db.update(part).set({ state: 'draft' }).where(eq(part.id, p.id)).run();
		const r = await recv(s, po.id, [{ lineId: po.lines[0].id, quantity: '1', location: 'A' }]);
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('draft_parts_blocked');
	});
});

describe('expense ledger', () => {
	test('each received line writes a receipt with the unit cost frozen and the total derived', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await orderedPo(s, p.id, '4');
		await recv(s, po.id, [{ lineId: po.lines[0].id, quantity: '2', location: 'A' }]);
		await recv(s, po.id, [{ lineId: po.lines[0].id, quantity: '1', location: 'A' }]);
		const rows = (await s.call('GET', `/purchases/${po.id}/expenses`)).body;
		expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['receipt', 'receipt']);
		expect(rows[0]).toMatchObject({ quantity: '2', unitCost: '1.5', totalCost: '3', partId: p.id });
	});

	test('a receipt without a unit cost has no total', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '1' }] });
		await setStatus(s, po.id, 'ordered');
		await recv(s, po.id, [{ lineId: po.lines[0].id, quantity: '1', location: 'A' }]);
		const row = (await s.call('GET', `/purchases/${po.id}/expenses`)).body[0];
		expect(row.unitCost).toBeNull();
		expect(row.totalCost).toBeNull();
	});

	test('the ledger is empty before any receipt, and unknown orders are not found', async () => {
		const s = await setup();
		const po = await mkPo(s);
		expect((await s.call('GET', `/purchases/${po.id}/expenses`)).body).toEqual([]);
		expect((await s.call('GET', '/purchases/999/expenses')).status).toBe(404);
	});

	test('charges can be added, listed and removed; an unknown kind is refused', async () => {
		const s = await setup();
		const po = await mkPo(s);
		const r = await s.call('POST', `/purchases/${po.id}/expenses`, { kind: 'shipping', amount: '12.30', note: 'Carrier invoice' });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ kind: 'shipping', totalCost: '12.3', partId: null, notes: 'Carrier invoice' });
		expect((await s.call('GET', `/purchases/${po.id}/expenses`)).body).toHaveLength(1);
		expect((await s.call('POST', `/purchases/${po.id}/expenses`, { kind: 'bribe', amount: '1' })).status).toBe(422);
		expect((await s.call('DELETE', `/purchases/${po.id}/expenses/${r.body.id}`)).status).toBe(200);
		expect((await s.call('GET', `/purchases/${po.id}/expenses`)).body).toEqual([]);
	});

	test('no charge can be added to a cancelled order', async () => {
		const s = await setup();
		const po = await mkPo(s);
		await setStatus(s, po.id, 'cancelled');
		expect((await s.call('POST', `/purchases/${po.id}/expenses`, { kind: 'fee', amount: '1' })).status).toBe(409);
	});

	test('receipt rows are permanent', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '1');
		await recv(s, po.id, [{ lineId: po.lines[0].id, quantity: '1', location: 'A' }]);
		const row = (await s.call('GET', `/purchases/${po.id}/expenses`)).body[0];
		expect((await s.call('DELETE', `/purchases/${po.id}/expenses/${row.id}`)).status).toBe(409);
	});
});

describe('listing', () => {
	test('filters by supplier, status, open, awaiting, overdue, text and target date, and sorts', async () => {
		const s = await setup();
		const sup = await mkSupplier(s, 'Filter Supplier');
		const p = makePart(s.db);
		const a = await mkPo(s, { supplierId: sup.id, supplierName: null, lines: [{ partId: p.id, qtyOrdered: '1' }] });
		const b = await mkPo(s, { supplierName: 'Other Vendor', targetDate: '2020-01-01' });
		await setStatus(s, a.id, 'ordered');
		const ids = async (q: string) => (await s.call('GET', `/purchases${q}`)).body.items.map((i: { id: number }) => i.id);
		expect(await ids(`?supplierId=${sup.id}`)).toEqual([a.id]);
		expect(await ids('?status=ordered')).toEqual([a.id]);
		expect(await ids('?open=true')).toHaveLength(2);
		expect(await ids('?awaiting=true')).toEqual([a.id]);
		expect(await ids('?overdue=true')).toEqual([b.id]);
		expect(await ids('?q=other')).toEqual([b.id]);
		expect(await ids('?supplier=filter')).toEqual([a.id]);
		expect(await ids('?targetTo=2021-01-01')).toEqual([b.id]);
		expect(await ids('?sort=reference&dir=asc')).toEqual([a.id, b.id]);
		expect((await s.call('GET', '/purchases?sort=nope')).status).toBe(422);
		const first = (await s.call('GET', '/purchases?limit=1&sort=reference&dir=asc')).body;
		expect(first.total).toBe(2);
		expect(first.next).toBe('1');
		expect((await s.call('GET', '/purchases?limit=1&sort=reference&dir=asc&cursor=1')).body.next).toBeNull();
	});

	test('list items count complete lines', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '1');
		await recv(s, po.id, [{ lineId: po.lines[0].id, quantity: '1', location: 'A' }]);
		const item = (await s.call('GET', '/purchases')).body.items[0];
		expect(item).toMatchObject({ totalLines: 1, linesComplete: 1, totalCost: '1.5' });
	});
});

describe('part references', () => {
	test('a part on an order, or in a supplier catalog, is referenced and cannot be deleted', async () => {
		const s = await setup();
		const p = makePart(s.db);
		await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '1' }] });
		const d = await s.call('GET', `/parts/${p.id}/detail`);
		expect(d.body.references.purchase_lines).toBe(1);
		expect((await s.call('DELETE', `/parts/${p.id}`)).status).toBe(409);
		const q = makePart(s.db);
		const sup = await mkSupplier(s);
		await s.call('POST', `/suppliers/${sup.id}/parts`, { partId: q.id, vendorPn: 'X' });
		expect((await s.call('GET', `/parts/${q.id}/detail`)).body.references.supplier_entries).toBe(1);
	});

	test('the part page lists its order lines, newest first', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const a = await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '2', unitCost: '3' }], targetDate: '2030-05-01' });
		await new Promise((r) => setTimeout(r, 3));
		const b = await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '1' }] });
		const rows = (await s.call('GET', `/parts/${p.id}/po-lines`)).body;
		expect(rows.map((r: { purchaseId: number }) => r.purchaseId)).toEqual([b.id, a.id]);
		expect(rows[1]).toMatchObject({ reference: a.reference, supplierName: 'Acme', qtyOrdered: '2', qtyReceived: '0', unitCost: '3', targetDate: '2030-05-01' });
	});
});
