/** The paper test for purchase orders (RECORDS.md): draft is pencil, a placed order is pen. */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import { apiToken, auditLog, purchase, purchaseLine } from '../../src/db/schema/index.ts';
import { makePart, mkPo, mkSupplier, orderedPo, recv, setStatus, setup } from './helpers.ts';

const line = (po: { lines: { id: number }[] }, n = 0) => po.lines[n]!.id;
const get = async (s: Awaited<ReturnType<typeof setup>>, id: number) => (await s.call('GET', `/purchases/${id}`)).body;

describe('draft is pencil', () => {
	test('a draft takes every edit: supplier, header and lines, which can be removed', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const other = await mkSupplier(s, 'Other');
		const po = await mkPo(s, { lines: [{ partId: p.id, qtyOrdered: '2', unitCost: '1' }] });
		expect((await s.call('PATCH', `/purchases/${po.id}`, { supplierId: other.id, destination: 'Bay 2' })).body).toMatchObject({
			supplierName: 'Other',
			destination: 'Bay 2'
		});
		const up = await s.call('PATCH', `/purchases/${po.id}/lines/${line(po)}`, { qtyOrdered: '9', unitCost: '3' });
		expect(up.body).toMatchObject({ qtyOrdered: '9', unitCost: '3' });
		expect((await s.call('DELETE', `/purchases/${po.id}/lines/${line(po)}`)).status).toBe(200);
		expect((await get(s, po.id)).lines).toEqual([]);
	});

	test('discarding a draft deletes it and its lines, and writes delete rows to the audit log', async () => {
		const s = await setup();
		const po = await mkPo(s, { lines: [{ partId: makePart(s.db).id, qtyOrdered: '1' }] });
		expect((await s.call('DELETE', `/purchases/${po.id}`)).status).toBe(200);
		expect((await s.call('GET', `/purchases/${po.id}`)).status).toBe(404);
		expect(s.db.select().from(purchaseLine).where(eq(purchaseLine.purchaseId, po.id)).all()).toEqual([]);
		const gone = s.db.select().from(auditLog).where(eq(auditLog.action, 'delete')).all().map((a) => a.entity);
		expect(gone).toContain('purchase');
		expect(gone).toContain('purchase_line');
	});

	test('a placed order cannot be discarded', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id);
		expect((await s.call('DELETE', `/purchases/${po.id}`)).status).toBe(409);
		expect(s.db.select().from(purchase).where(eq(purchase.id, po.id)).all()).toHaveLength(1);
	});
});

describe('a placed order is pen', () => {
	test('a placed order refuses to edit a line', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '5');
		const r = await s.call('PATCH', `/purchases/${po.id}/lines/${line(po)}`, { qtyOrdered: '1', unitCost: '9' });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('line_locked');
		expect((await get(s, po.id)).lines[0]).toMatchObject({ qtyOrdered: '5', unitCost: '1.5' });
	});

	test('a placed order refuses to remove a line', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '5');
		expect((await s.call('DELETE', `/purchases/${po.id}/lines/${line(po)}`)).status).toBe(409);
		expect((await get(s, po.id)).lines).toHaveLength(1);
	});

	test('a placed order refuses a supplier change, by id or by name', async () => {
		const s = await setup();
		const other = await mkSupplier(s, 'Other');
		const po = await orderedPo(s, makePart(s.db).id);
		const byId = await s.call('PATCH', `/purchases/${po.id}`, { supplierId: other.id });
		expect(byId.status).toBe(409);
		expect(byId.body.error).toBe('supplier_locked');
		expect((await s.call('PATCH', `/purchases/${po.id}`, { supplierName: 'Else' })).status).toBe(409);
		expect((await get(s, po.id)).supplierName).toBe('Acme');
	});

	test('an order never returns to draft and its placing date never clears', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id);
		const placedAt = (await get(s, po.id)).orderedAt;
		expect(placedAt).not.toBeNull();
		await s.call('PATCH', `/purchases/${po.id}`, { status: 'draft' });
		await setStatus(s, po.id, 'on_hold');
		await setStatus(s, po.id, 'ordered');
		const after = await get(s, po.id);
		expect(after.status).toBe('ordered');
		expect(after.orderedAt).toBe(placedAt);
		expect((await s.call('POST', `/purchases/${po.id}/place`, {})).status).toBe(409);
	});

	test('a header change after placing shows old and new, who and when in the order changes', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '1', { destination: 'Bay 1' });
		await s.call('PATCH', `/purchases/${po.id}`, { destination: 'Bay 2', targetDate: '2030-01-01' });
		const changes = (await get(s, po.id)).changes;
		expect(changes.find((c: { field: string }) => c.field === 'destination')).toMatchObject({
			scope: 'order',
			old: 'Bay 1',
			new: 'Bay 2',
			userName: 'Ada Admin'
		});
		expect(changes.find((c: { field: string }) => c.field === 'targetDate')).toMatchObject({ old: null, new: '2030-01-01' });
	});

	test('edits made while the order was a draft are not history', async () => {
		const s = await setup();
		const po = await mkPo(s, { lines: [{ partId: makePart(s.db).id, qtyOrdered: '1' }] });
		await s.call('PATCH', `/purchases/${po.id}`, { destination: 'Bay 1' });
		await s.call('POST', `/purchases/${po.id}/place`, {});
		const fields = (await get(s, po.id)).changes.map((c: { field: string }) => c.field);
		expect(fields).toEqual(['status']);
	});

	test('a draft edit in the same millisecond as placing is not history', async () => {
		const s = await setup();
		const po = await mkPo(s, { lines: [{ partId: makePart(s.db).id, qtyOrdered: '1' }] });
		await s.call('PATCH', `/purchases/${po.id}`, { destination: 'Bay 1' });
		await s.call('POST', `/purchases/${po.id}/place`, {});
		const placed = await get(s, po.id);
		s.db.update(auditLog).set({ at: placed.orderedAt }).where(eq(auditLog.entity, 'purchase')).run();
		const fields = (await get(s, po.id)).changes.map((c: { field: string }) => c.field);
		expect(fields).toEqual(['status']);
	});

	test('adding a line after placing is allowed and shows in the changes', async () => {
		const s = await setup();
		const extra = makePart(s.db);
		const po = await orderedPo(s, makePart(s.db).id);
		const add = await s.call('POST', `/purchases/${po.id}/lines`, { partId: extra.id, qtyOrdered: '4' });
		expect(add.status).toBe(200);
		expect((await get(s, po.id)).changes).toContainEqual(
			expect.objectContaining({ scope: 'line', field: 'line', new: '4', partInternalPn: extra.internalPn })
		);
	});

	test('a held order takes no amendment, strike or new line, and resuming reopens them', async () => {
		const s = await setup();
		const p = makePart(s.db);
		const po = await orderedPo(s, p.id, '4');
		await setStatus(s, po.id, 'on_hold');
		const base = `/purchases/${po.id}/lines/${line(po)}`;
		expect((await s.call('POST', `${base}/amend`, { qtyOrdered: '5', reason: 'r' })).status).toBe(409);
		expect((await s.call('POST', `${base}/cancel`, { reason: 'r' })).status).toBe(409);
		expect((await s.call('POST', `/purchases/${po.id}/lines`, { partId: p.id, qtyOrdered: '1' })).status).toBe(409);
		await setStatus(s, po.id, 'ordered');
		expect((await s.call('POST', `${base}/amend`, { qtyOrdered: '5', reason: 'r' })).status).toBe(200);
	});
});

describe('amending a line', () => {
	test('an amendment needs a reason', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '5');
		const base = `/purchases/${po.id}/lines/${line(po)}/amend`;
		expect((await s.call('POST', base, { qtyOrdered: '6' })).status).toBe(422);
		expect((await s.call('POST', base, { qtyOrdered: '6', reason: '  ' })).status).toBe(422);
		expect((await get(s, po.id)).lines[0].qtyOrdered).toBe('5');
	});

	test('an amendment keeps the old value with the new one, who, when and why', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '5');
		const r = await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/amend`, {
			qtyOrdered: '8',
			unitCost: '2',
			destination: 'Bay 3',
			reason: 'Supplier quote changed'
		});
		expect(r.body).toMatchObject({ qtyOrdered: '8', unitCost: '2', destination: 'Bay 3' });
		const changes = (await get(s, po.id)).changes.filter((c: { reason: string | null }) => c.reason);
		expect(changes).toHaveLength(3);
		expect(changes.find((c: { field: string }) => c.field === 'qtyOrdered')).toMatchObject({
			lineId: line(po),
			old: '5',
			new: '8',
			reason: 'Supplier quote changed',
			userName: 'Ada Admin'
		});
		expect(changes.find((c: { field: string }) => c.field === 'unitCost')).toMatchObject({ old: '1.5', new: '2' });
		expect(changes.find((c: { field: string }) => c.field === 'destination')).toMatchObject({ old: null, new: 'Bay 3' });
	});

	test('an amendment that changes nothing is refused', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '5');
		const r = await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/amend`, { qtyOrdered: '5', reason: 'same' });
		expect(r.status).toBe(422);
	});

	test('an amended quantity cannot go below what arrived or was struck, and the cost of received goods stays', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '10');
		await s.call('POST', `/purchases/${po.id}/lines`, { partId: makePart(s.db).id, qtyOrdered: '1' });
		await recv(s, po.id, [{ lineId: line(po), quantity: '4', location: 'A' }]);
		const base = `/purchases/${po.id}/lines/${line(po)}/amend`;
		expect((await s.call('POST', base, { qtyOrdered: '3', reason: 'r' })).status).toBe(422);
		expect((await s.call('POST', base, { unitCost: '9', reason: 'r' })).status).toBe(422);
		await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/cancel`, { reason: 'drop the rest' });
		expect((await s.call('POST', base, { qtyOrdered: '11', reason: 'r' })).status).toBe(200);
		expect((await s.call('POST', base, { qtyOrdered: '9', reason: 'r' })).status).toBe(422);
	});

	test('a draft cannot be amended', async () => {
		const s = await setup();
		const po = await mkPo(s, { lines: [{ partId: makePart(s.db).id, qtyOrdered: '1' }] });
		expect((await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/amend`, { qtyOrdered: '2', reason: 'r' })).status).toBe(409);
	});
});

describe('cancelling a line', () => {
	test('cancelling a line strikes the outstanding quantity, keeps the line, and needs a reason', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '5');
		const other = await s.call('POST', `/purchases/${po.id}/lines`, { partId: makePart(s.db).id, qtyOrdered: '2' });
		const base = `/purchases/${po.id}/lines/${other.body.id}/cancel`;
		expect((await s.call('POST', base, {})).status).toBe(422);
		const r = await s.call('POST', base, { reason: 'Wrong part' });
		expect(r.body).toMatchObject({ qtyOrdered: '2', qtyCancelled: '2', qtyOutstanding: '0', isComplete: true });
		const now = await get(s, po.id);
		expect(now.lines).toHaveLength(2);
		expect(now.status).toBe('ordered');
		expect(now.changes).toContainEqual(
			expect.objectContaining({ field: 'qtyCancelled', old: '0', new: '2', reason: 'Wrong part', lineId: other.body.id })
		);
		expect((await s.call('POST', base, { reason: 'again' })).status).toBe(409);
	});

	test('a line with receipts keeps its received quantity and cancels only the rest', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '10');
		await recv(s, po.id, [{ lineId: line(po), quantity: '4', location: 'A' }]);
		const r = await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/cancel`, { reason: 'Short shipped' });
		expect(r.body).toMatchObject({ qtyOrdered: '10', qtyReceived: '4', qtyCancelled: '6', qtyOutstanding: '0' });
	});

	test('cancelling every open line of an order with nothing received cancels the order, never receives it', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/cancel`, { reason: 'Not needed' });
		const now = await get(s, po.id);
		expect(now.status).toBe('cancelled');
		expect(now.receivedAt).toBeNull();
		expect(now.closedReason).toBe('Not needed');
	});

	test('cancelling every open line after a delivery closes the order short', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		await recv(s, po.id, [{ lineId: line(po), quantity: '1', location: 'A' }]);
		await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/cancel`, { reason: 'Supplier out' });
		const now = await get(s, po.id);
		expect(now.status).toBe('closed_short');
		expect(now.closedReason).toBe('Supplier out');
	});
});

describe('striking the whole order', () => {
	test('cancelling an order needs a reason and strikes every line, which stay on the page', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		expect((await s.call('POST', `/purchases/${po.id}/cancel`, {})).status).toBe(422);
		const r = await s.call('POST', `/purchases/${po.id}/cancel`, { reason: 'Project dropped' });
		expect(r.body.status).toBe('cancelled');
		expect(r.body.closedReason).toBe('Project dropped');
		expect(r.body.lines[0]).toMatchObject({ qtyOrdered: '3', qtyCancelled: '3', qtyOutstanding: '0' });
	});

	test('an order that took a delivery cannot be cancelled, only closed short', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		await recv(s, po.id, [{ lineId: line(po), quantity: '1', location: 'A' }]);
		const r = await s.call('POST', `/purchases/${po.id}/cancel`, { reason: 'r' });
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('has_receipts');
	});

	test('closing short needs a reason, a delivery, and strikes the shortfall', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		const url = `/purchases/${po.id}/close-short`;
		expect((await s.call('POST', url, { reason: 'r' })).status).toBe(409);
		await recv(s, po.id, [{ lineId: line(po), quantity: '1', location: 'A' }]);
		expect((await s.call('POST', url, {})).status).toBe(422);
		const r = await s.call('POST', url, { reason: 'Back-ordered for good' });
		expect(r.body).toMatchObject({ status: 'closed_short', closedReason: 'Back-ordered for good' });
		expect(r.body.lines[0]).toMatchObject({ qtyReceived: '1', qtyCancelled: '2', qtyOutstanding: '0' });
	});

	test('a held order closes short after a delivery and cancels before one', async () => {
		const s = await setup();
		const a = await orderedPo(s, makePart(s.db).id, '3');
		await recv(s, a.id, [{ lineId: line(a), quantity: '1', location: 'A' }]);
		await setStatus(s, a.id, 'on_hold');
		expect((await s.call('POST', `/purchases/${a.id}/close-short`, { reason: 'r' })).body.status).toBe('closed_short');
		const b = await orderedPo(s, makePart(s.db).id, '3');
		await setStatus(s, b.id, 'on_hold');
		expect((await s.call('POST', `/purchases/${b.id}/cancel`, { reason: 'r' })).body.status).toBe('cancelled');
	});

	test('a closed order takes no deliveries and no further strikes', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '3');
		await recv(s, po.id, [{ lineId: line(po), quantity: '1', location: 'A' }]);
		await s.call('POST', `/purchases/${po.id}/close-short`, { reason: 'r' });
		expect((await recv(s, po.id, [{ lineId: line(po), quantity: '1', location: 'A' }])).status).toBe(409);
		expect((await s.call('POST', `/purchases/${po.id}/close-short`, { reason: 'r' })).status).toBe(409);
		expect((await s.call('POST', `/purchases/${po.id}/lines/${line(po)}/cancel`, { reason: 'r' })).status).toBe(409);
	});

	test('a closed short order still takes a charge, a cancelled one does not', async () => {
		const s = await setup();
		const a = await orderedPo(s, makePart(s.db).id, '3');
		await recv(s, a.id, [{ lineId: line(a), quantity: '1', location: 'A' }]);
		await s.call('POST', `/purchases/${a.id}/close-short`, { reason: 'r' });
		expect((await s.call('POST', `/purchases/${a.id}/expenses`, { kind: 'shipping', amount: '5' })).status).toBe(200);
		const b = await orderedPo(s, makePart(s.db).id, '3');
		await s.call('POST', `/purchases/${b.id}/cancel`, { reason: 'r' });
		expect((await s.call('POST', `/purchases/${b.id}/expenses`, { kind: 'shipping', amount: '5' })).status).toBe(409);
	});
});

describe('copy to new draft', () => {
	test('a received, closed short or cancelled order copies to a new draft with the same lines', async () => {
		const s = await setup();
		const sup = await mkSupplier(s, 'Bolt Co');
		const p = makePart(s.db);
		const mk = async () => {
			const po = await mkPo(s, { supplierId: sup.id, lines: [{ partId: p.id, qtyOrdered: '3', unitCost: '2', destination: 'Bay 1' }] });
			await s.call('POST', `/purchases/${po.id}/place`, {});
			return po;
		};
		const done = await mk();
		await recv(s, done.id, [{ lineId: line(done), quantity: '3', location: 'A' }]);
		const short = await mk();
		await recv(s, short.id, [{ lineId: line(short), quantity: '1', location: 'A' }]);
		await s.call('POST', `/purchases/${short.id}/close-short`, { reason: 'r' });
		const dead = await mk();
		await s.call('POST', `/purchases/${dead.id}/cancel`, { reason: 'r' });
		for (const src of [done, short, dead]) {
			const r = await s.call('POST', `/purchases/${src.id}/copy`, {});
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({ status: 'draft', supplierName: 'Bolt Co', orderedAt: null, changes: [] });
			expect(r.body.id).not.toBe(src.id);
			expect(r.body.reference).not.toBe(src.reference);
			expect(r.body.lines).toHaveLength(1);
			expect(r.body.lines[0]).toMatchObject({ partId: p.id, qtyOrdered: '3', unitCost: '2', destination: 'Bay 1', qtyCancelled: '0' });
		}
	});

	test('a draft or a live order does not copy', async () => {
		const s = await setup();
		const draft = await mkPo(s, { lines: [{ partId: makePart(s.db).id, qtyOrdered: '1' }] });
		expect((await s.call('POST', `/purchases/${draft.id}/copy`, {})).status).toBe(409);
		const live = await orderedPo(s, makePart(s.db).id);
		expect((await s.call('POST', `/purchases/${live.id}/copy`, {})).status).toBe(409);
	});
});

describe('charges on an order', () => {
	const charge = async (s: Awaited<ReturnType<typeof setup>>, id: number) =>
		(await s.call('POST', `/purchases/${id}/expenses`, { kind: 'shipping', amount: '12.50', note: 'Carrier' })).body;
	const ledger = async (s: Awaited<ReturnType<typeof setup>>, id: number) =>
		(await s.call('GET', `/purchases/${id}/expenses`)).body;

	test('a charge on a draft is pencil and can be removed, not struck', async () => {
		const s = await setup();
		const po = await mkPo(s);
		const c = await charge(s, po.id);
		expect((await s.call('POST', `/purchases/${po.id}/expenses/${c.id}/strike`, { reason: 'r' })).status).toBe(409);
		expect((await s.call('DELETE', `/purchases/${po.id}/expenses/${c.id}`)).status).toBe(200);
		expect(await ledger(s, po.id)).toEqual([]);
	});

	test('a charge on a placed order cannot be removed: pen cannot remove a line', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id);
		const c = await charge(s, po.id);
		const x = await s.call('DELETE', `/purchases/${po.id}/expenses/${c.id}`);
		expect(x.status).toBe(409);
		expect(x.body.message).toContain('Strike');
		expect(await ledger(s, po.id)).toHaveLength(1);
	});

	test('striking a charge needs a reason, keeps it legible with who, when and why, and logs the reason', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id);
		const c = await charge(s, po.id);
		expect((await s.call('POST', `/purchases/${po.id}/expenses/${c.id}/strike`, { reason: ' ' })).status).toBe(422);
		const r = await s.call('POST', `/purchases/${po.id}/expenses/${c.id}/strike`, { reason: 'Billed twice' });
		expect(r.status).toBe(200);
		expect(r.body.struck).toMatchObject({ byName: 'Ada Admin', reason: 'Billed twice' });
		const [row] = await ledger(s, po.id);
		expect(row).toMatchObject({ id: c.id, totalCost: '12.5', notes: 'Carrier' });
		expect(row.struck).toMatchObject({ byName: 'Ada Admin', reason: 'Billed twice' });
		expect(row.struck.at).toBeTruthy();
		const audit = s.db.select().from(auditLog).where(eq(auditLog.op, 'purchasing.orders.strikeCharge')).all();
		expect(audit[0]).toMatchObject({ entity: 'purchase_expense', reason: 'Billed twice' });
		expect((await s.call('POST', `/purchases/${po.id}/expenses/${c.id}/strike`, { reason: 'again' })).status).toBe(409);
	});

	test('a charge can be struck once the order has closed, and a receipt row never can', async () => {
		const s = await setup();
		const po = await orderedPo(s, makePart(s.db).id, '1');
		const c = await charge(s, po.id);
		await recv(s, po.id, [{ lineId: line(po), quantity: '1', location: 'A' }]);
		expect((await get(s, po.id)).status).toBe('received');
		expect((await s.call('POST', `/purchases/${po.id}/expenses/${c.id}/strike`, { reason: 'Refunded' })).status).toBe(200);
		const receipt = (await ledger(s, po.id)).find((e: { kind: string }) => e.kind === 'receipt');
		expect((await s.call('POST', `/purchases/${po.id}/expenses/${receipt.id}/strike`, { reason: 'r' })).status).toBe(409);
	});
});

describe('agents prepare, people commit', () => {
	/** The same database, called as an API token. */
	async function asToken() {
		const s = await setup();
		const tokenId = s.db
			.insert(apiToken)
			.values({ userId: s.admin.id, name: 't', tokenHash: 'h', createdAt: new Date().toISOString() })
			.returning()
			.get().id;
		let actor: Actor = { kind: 'user', userId: s.admin.id, isAdmin: true, sessionId: 1 };
		const app = createApp({ db: s.db, resolveActor: () => actor });
		const call = async (method: string, path: string, body?: unknown) => {
			const res = await app.request(`/api${path}`, {
				method,
				headers: body === undefined ? {} : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const text = await res.text();
			return { status: res.status, body: text ? JSON.parse(text) : null };
		};
		return {
			s,
			call,
			token: () => (actor = { kind: 'token', userId: s.admin.id, isAdmin: true, tokenId }),
			person: () => (actor = { kind: 'user', userId: s.admin.id, isAdmin: true, sessionId: 1 })
		};
	}

	test('an API token can add a charge but cannot remove or strike one on a placed order', async () => {
		const t = await asToken();
		const po = await orderedPo(t.s, makePart(t.s.db).id);
		t.token();
		const c = await t.call('POST', `/purchases/${po.id}/expenses`, { kind: 'fee', amount: '1' });
		expect(c.status).toBe(200);
		expect((await t.call('DELETE', `/purchases/${po.id}/expenses/${c.body.id}`)).status).toBe(409);
		expect((await t.call('POST', `/purchases/${po.id}/expenses/${c.body.id}/strike`, { reason: 'r' })).status).toBe(403);
		expect((await t.call('GET', `/purchases/${po.id}/expenses`)).body[0].struck).toBeNull();
	});

	test('an API token cannot place, hold, resume, amend, cancel a line, cancel or close short', async () => {
		const t = await asToken();
		const po = await orderedPo(t.s, makePart(t.s.db).id, '4');
		const lineId = line(po);
		await recv(t.s, po.id, [{ lineId, quantity: '1', location: 'A' }]);
		const draft = await mkPo(t.s, { lines: [{ partId: makePart(t.s.db).id, qtyOrdered: '1' }] });
		t.token();
		const refused = [
			t.call('POST', `/purchases/${draft.id}/place`, {}),
			t.call('POST', `/purchases/${po.id}/hold`, {}),
			t.call('POST', `/purchases/${po.id}/resume`, {}),
			t.call('POST', `/purchases/${po.id}/lines/${lineId}/amend`, { qtyOrdered: '5', reason: 'r' }),
			t.call('POST', `/purchases/${po.id}/lines/${lineId}/cancel`, { reason: 'r' }),
			t.call('POST', `/purchases/${po.id}/cancel`, { reason: 'r' }),
			t.call('POST', `/purchases/${po.id}/close-short`, { reason: 'r' })
		];
		for (const r of await Promise.all(refused)) expect(r.status).toBe(403);
		t.person();
		expect((await get(t.s, po.id)).status).toBe('partial');
		expect((await get(t.s, draft.id)).status).toBe('draft');
	});

	test('an API token can draft, copy, discard and receive', async () => {
		const t = await asToken();
		const p = makePart(t.s.db);
		const placed = await orderedPo(t.s, p.id, '2');
		t.token();
		const made = await t.call('POST', '/purchases', { supplierName: 'Acme', lines: [{ partId: p.id, qtyOrdered: '1' }] });
		expect(made.status).toBe(201);
		expect((await t.call('PATCH', `/purchases/${made.body.id}`, { destination: 'Bay 1' })).status).toBe(200);
		expect((await t.call('DELETE', `/purchases/${made.body.id}`)).status).toBe(200);
		const got = await t.call('POST', `/purchases/${placed.id}/receive`, { lines: [{ lineId: line(placed), quantity: '2', location: 'A' }] });
		expect(got.status).toBe(200);
		expect(got.body.status).toBe('received');
		expect((await t.call('POST', `/purchases/${placed.id}/copy`, {})).status).toBe(200);
	});
});
