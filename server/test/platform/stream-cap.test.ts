import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { maxStreamsPerUser } from '../../src/services/platform/files.ts';
import { setup } from './helpers.ts';

const saved = process.env.OPAL_MAX_STREAMS_PER_USER;
beforeEach(() => {
	process.env.OPAL_MAX_STREAMS_PER_USER = '2';
});
afterEach(() => {
	if (saved === undefined) delete process.env.OPAL_MAX_STREAMS_PER_USER;
	else process.env.OPAL_MAX_STREAMS_PER_USER = saved;
});

/** Opens a stream and reads the first frame, so the server has registered it. */
async function open(app: { request: (p: string) => Response | Promise<Response> }) {
	const res = await app.request('/api/events/stream');
	if (res.status !== 200) return { res, close: async () => {} };
	const reader = res.body!.getReader();
	await reader.read();
	return { res, close: () => reader.cancel() };
}

describe('event stream cap', () => {
	test('a person with the maximum number of streams open gets a 429 on the next one', async () => {
		const { app } = await setup();
		const a = await open(app);
		const b = await open(app);
		expect([a.res.status, b.res.status]).toEqual([200, 200]);
		const c = await open(app);
		expect(c.res.status).toBe(429);
		expect(await c.res.json()).toMatchObject({ error: 'too_many_streams' });
		await a.close();
		await b.close();
	});

	test('closing a stream frees its place at once', async () => {
		const { app } = await setup();
		const a = await open(app);
		const b = await open(app);
		await a.close();
		// Give the abort handler a turn to run.
		await new Promise((r) => setTimeout(r, 50));
		const c = await open(app);
		expect(c.res.status).toBe(200);
		await b.close();
		await c.close();
	});

	test("one person's streams do not count against another's", async () => {
		const { app, as } = await setup();
		const a = await open(app);
		const b = await open(app);
		as(1);
		const other = await open(app);
		expect(other.res.status).toBe(200);
		await a.close();
		await b.close();
		await other.close();
	});

	test('the default leaves room for many tabs, two streams each', () => {
		delete process.env.OPAL_MAX_STREAMS_PER_USER;
		expect(maxStreamsPerUser()).toBeGreaterThanOrEqual(20);
	});
});
