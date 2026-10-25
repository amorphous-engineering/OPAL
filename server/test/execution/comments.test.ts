import { describe, expect, test } from 'bun:test';
import { flushEvents, subscribe } from '../../src/services/platform/events.ts';
import { setup } from './helpers.ts';

describe('work order comments', () => {
	test('comments come back oldest first with their author', async () => {
		const t = await setup();
		const wo = await t.cut(await t.published());
		await t.ok('POST', `/executions/${wo.id}/comments`, { body: 'Torque wrench is out for calibration' });
		expect((await t.call('POST', `/executions/${wo.id}/comments`, { body: 'Borrowed one from bay 2' }, t.benActor)).status).toBe(200);
		const list = await t.ok('GET', `/executions/${wo.id}/comments`);
		expect(list.map((c: { body: string }) => c.body)).toEqual([
			'Torque wrench is out for calibration',
			'Borrowed one from bay 2'
		]);
		expect(list[1].author.name).toBe('BEN');
		expect(list[0].executionId).toBe(wo.id);
	});

	test('an empty comment is refused', async () => {
		const t = await setup();
		const wo = await t.cut(await t.published());
		const res = await t.call('POST', `/executions/${wo.id}/comments`, { body: '   ' });
		expect(res.status).toBe(422);
	});

	test('a comment on an unknown work order is refused', async () => {
		const t = await setup();
		expect((await t.call('POST', '/executions/9999/comments', { body: 'hello' })).status).toBe(404);
		expect((await t.call('GET', '/executions/9999/comments')).status).toBe(404);
	});

	test('a completed or cancelled work order still takes comments', async () => {
		const t = await setup();
		const wo = await t.cut(await t.published());
		await t.ok('POST', `/executions/${wo.id}/cancel`, { reason: 'scrapped' });
		const c = await t.ok('POST', `/executions/${wo.id}/comments`, { body: 'Parts went back to stock' });
		expect(c.body).toBe('Parts went back to stock');
	});

	test('a new comment tells every open view of the work order to reload the thread', async () => {
		const t = await setup();
		const wo = await t.cut(await t.published());
		const got: { type: string; data?: Record<string, unknown> }[] = [];
		const off = subscribe(null, (e) => got.push(e));
		await t.ok('POST', `/executions/${wo.id}/comments`, { body: 'Starting OP 2 after lunch' });
		await flushEvents();
		off();
		expect(got.some((e) => e.type === 'execution_comment' && e.data?.executionId === wo.id)).toBe(true);
	});
});
