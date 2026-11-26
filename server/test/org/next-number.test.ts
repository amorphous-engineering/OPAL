import { describe, expect, test } from 'bun:test';
import { nextDesignator } from '../../src/services/designators.ts';
import { nextReference } from '../../src/services/purchasing/orders.ts';
import { purchase } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

const ctxOf = (db: any) => ({ db });

describe('the number a new record would take', () => {
	test('reading it does not take it, and a create takes it', async () => {
		const { db, call, makeUser } = await setup();
		const bob = makeUser('bob');
		const peek = async () => (await call(bob, 'GET', '/settings/next-number?kind=issue')).json;
		expect(await peek()).toEqual({ first: 'IT-0001', last: 'IT-0001' });
		expect(await peek()).toEqual({ first: 'IT-0001', last: 'IT-0001' });
		expect(nextDesignator(ctxOf(db), 'IT')).toBe('IT-0000000001');
		expect(await peek()).toEqual({ first: 'IT-0002', last: 'IT-0002' });
	});

	test('a batch shows the range it would take', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const r = await call(bob, 'GET', '/settings/next-number?kind=workOrder&count=3');
		expect(r.json).toEqual({ first: 'WO-0001', last: 'WO-0003' });
	});

	test('a database from before the PO counter shows the reference after the highest in use', async () => {
		const { db, call, makeUser } = await setup();
		const bob = makeUser('bob');
		const ts = new Date().toISOString();
		db.insert(purchase).values({ reference: 'PO-0000000007', supplierName: 'Old supplier', createdAt: ts, updatedAt: ts } as never).run();
		expect((await call(bob, 'GET', '/settings/next-number?kind=purchase')).json.first).toBe('PO-0008');
		expect(nextReference(ctxOf(db))).toBe('PO-0000000008');
		expect((await call(bob, 'GET', '/settings/next-number?kind=purchase')).json.first).toBe('PO-0009');
	});

	test('a purchase shows the next PO reference', async () => {
		const { db, call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'GET', '/settings/next-number?kind=purchase')).json.first).toBe('PO-0001');
		expect(nextReference(ctxOf(db))).toBe('PO-0000000001');
		expect((await call(bob, 'GET', '/settings/next-number?kind=purchase')).json.first).toBe('PO-0002');
	});

	test('only a signed-in person can read it', async () => {
		const { call } = await setup();
		expect((await call(null, 'GET', '/settings/next-number?kind=risk')).status).toBe(401);
	});
});
