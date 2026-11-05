/** The paper test for stock records (RECORDS.md): lot, serial and expiry are corrected, never overwritten. */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.ts';
import { apiToken, stockMove } from '../../src/db/schema/index.ts';
import { makePart, receive, setup } from './helpers.ts';

const detail = async (s: Awaited<ReturnType<typeof setup>>, opal: string) =>
	(await s.call('GET', `/inventory/opal/${opal}/detail`)).body;

describe('correcting a stock record', () => {
	test('a correction of lot, serial or expiry needs a reason', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db).id, '4', 'A1', { lotNumber: 'L1' });
		expect((await s.call('POST', `/inventory/${rec.id}/correct`, { lotNumber: 'L2' })).status).toBe(422);
		expect((await s.call('POST', `/inventory/${rec.id}/correct`, { lotNumber: 'L2', reason: '  ' })).status).toBe(422);
		expect((await detail(s, rec.opalNumber)).record.lotNumber).toBe('L1');
	});

	test('a correction keeps the old value beside the new one, with who, when and why', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db).id, '4', 'A1', { lotNumber: 'L1' });
		const r = await s.call('POST', `/inventory/${rec.id}/correct`, {
			lotNumber: 'L2',
			expirationDate: '2031-02-03',
			reason: 'Label misread at receiving'
		});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ lotNumber: 'L2', expirationDate: '2031-02-03' });
		const corrections = (await detail(s, rec.opalNumber)).corrections;
		expect(corrections).toHaveLength(2);
		expect(corrections.find((c: { field: string }) => c.field === 'lotNumber')).toMatchObject({
			old: 'L1',
			new: 'L2',
			reason: 'Label misread at receiving',
			userName: 'Ada Admin'
		});
		expect(corrections.find((c: { field: string }) => c.field === 'expirationDate')).toMatchObject({
			old: null,
			new: '2031-02-03'
		});
	});

	test('a serial correction is kept the same way', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db, { tracking: 'serialized' }).id, '1', 'A1', { serialNumber: 'S1' });
		await s.call('POST', `/inventory/${rec.id}/correct`, { serialNumber: 'S2', reason: 'Typo' });
		expect((await detail(s, rec.opalNumber)).corrections).toEqual([
			expect.objectContaining({ field: 'serialNumber', old: 'S1', new: 'S2', reason: 'Typo' })
		]);
	});

	test('a correction that changes nothing is refused', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db).id, '4', 'A1', { lotNumber: 'L1' });
		expect((await s.call('POST', `/inventory/${rec.id}/correct`, { lotNumber: 'L1', reason: 'same' })).status).toBe(422);
	});

	test('the ledger stays append-only: a correction adds no move and leaves the balance', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db).id, '4', 'A1', { lotNumber: 'L1' });
		const before = s.db.select().from(stockMove).where(eq(stockMove.stockId, rec.id)).all();
		await s.call('POST', `/inventory/${rec.id}/correct`, { lotNumber: 'L2', reason: 'Typo' });
		expect(s.db.select().from(stockMove).where(eq(stockMove.stockId, rec.id)).all()).toEqual(before);
		expect((await detail(s, rec.opalNumber)).record.balance).toBe('4');
	});

	test('a move of the whole record is not a correction', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db).id, '4', 'A1', { lotNumber: 'L1' });
		await s.call('POST', '/inventory/transfer', { sourceId: rec.id, targetLocation: 'B2', quantity: '4', targetLotNumber: 'L9' });
		expect((await detail(s, rec.opalNumber)).corrections).toEqual([]);
	});

	test('an API token cannot correct a record', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db).id, '4', 'A1', { lotNumber: 'L1' });
		const tokenId = s.db
			.insert(apiToken)
			.values({ userId: s.admin.id, name: 't', tokenHash: 'h', createdAt: new Date().toISOString() })
			.returning()
			.get().id;
		const app = createApp({
			db: s.db,
			resolveActor: () => ({ kind: 'token', userId: s.admin.id, isAdmin: true, tokenId })
		});
		const res = await app.request(`/api/inventory/${rec.id}/correct`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lotNumber: 'L2', reason: 'agent' })
		});
		expect(res.status).toBe(403);
		expect((await detail(s, rec.opalNumber)).record.lotNumber).toBe('L1');
	});
});

describe('scrapping stock', () => {
	test('a scrap needs a note that says why, and the note lands on the ledger', async () => {
		const s = await setup();
		const rec = await receive(s, makePart(s.db).id, '4');
		const url = `/inventory/${rec.id}/adjust`;
		expect((await s.call('POST', url, { adjustment: '-1', reason: 'scrap' })).status).toBe(422);
		expect((await s.call('POST', url, { adjustment: '-1', reason: 'scrap', notes: '  ' })).status).toBe(422);
		expect((await s.call('POST', url, { adjustment: '-1', reason: 'scrap', notes: 'Dropped on the floor' })).status).toBe(200);
		const ledger = (await detail(s, rec.opalNumber)).ledger;
		expect(ledger.at(-1)).toMatchObject({ reason: 'scrap', notes: 'Dropped on the floor', qty: '-1' });
	});
});
