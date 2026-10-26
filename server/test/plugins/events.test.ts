import { describe, expect, test } from 'bun:test';
import { flushEvents, publish, subscribe } from '../../src/services/platform/events.ts';
import { insert } from '../../src/write.ts';
import { project } from '../../src/db/schema/index.ts';
import { addPlugin, setup } from './helpers.ts';

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, buf = ''): Promise<string> {
	const dec = new TextDecoder();
	while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value);
	return buf;
}

describe('plugin events', () => {
	test('an event for plugins reaches a plugin subscriber and never a browser one', async () => {
		const browser: string[] = [];
		const plug: string[] = [];
		const off1 = subscribe(1, (e) => browser.push(e.type));
		const off2 = subscribe(2, (e) => plug.push(e.type), { plugin: true });
		publish({ type: 'record_changed', audience: 'plugins' });
		publish({ type: 'issue_created' });
		await flushEvents();
		expect(browser).toEqual(['issue_created']);
		expect(plug).toEqual(['record_changed', 'issue_created']);
		off1();
		off2();
	});

	test('an audited write publishes record_changed to plugins only', async () => {
		const s = await setup();
		const seen: { type: string; data: Record<string, unknown> }[] = [];
		const off1 = subscribe(1, (e) => seen.push({ type: `browser:${e.type}`, data: e.data }));
		const off2 = subscribe(2, (e) => seen.push(e), { plugin: true });
		insert({ db: s.db, actor: { kind: 'system' }, op: 'test.write' }, project, { name: 'P', code: 'PX' } as never);
		await flushEvents();
		off1();
		off2();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: 'record_changed', data: { entity: 'project', action: 'create', op: 'test.write' } });
	});

	test('the stream gives a scoped token only the events its scopes match, and heartbeats', async () => {
		const s = await setup();
		const plug = addPlugin(s.db, 'kaneo');
		s.setActor({ kind: 'token', userId: plug.user.id, isAdmin: false, tokenId: 1, scopes: { ops: [], events: ['record_*', 'issue_created'] } });
		const res = await s.app.request('/api/events/stream');
		const reader = res.body!.getReader();
		let buf = await readUntil(reader, 'heartbeat');
		publish({ type: 'step_completed' });
		publish({ type: 'record_changed', data: { entity: 'issue' }, audience: 'plugins' });
		buf = await readUntil(reader, 'record_changed', buf);
		await reader.cancel();
		expect(buf).not.toContain('step_completed');
	});

	test('the stream gives a browser session no record_changed', async () => {
		const s = await setup();
		const res = await s.app.request('/api/events/stream');
		const reader = res.body!.getReader();
		let buf = await readUntil(reader, 'heartbeat');
		publish({ type: 'record_changed', audience: 'plugins' });
		publish({ type: 'step_completed' });
		buf = await readUntil(reader, 'step_completed', buf);
		await reader.cancel();
		expect(buf).not.toContain('record_changed');
	});

	test('an unscoped token is not a plugin subscriber', async () => {
		const s = await setup();
		s.setActor({ kind: 'token', userId: s.person.id, isAdmin: true, tokenId: 1 });
		const reader = (await s.app.request('/api/events/stream')).body!.getReader();
		let buf = await readUntil(reader, 'heartbeat');
		publish({ type: 'record_changed', audience: 'plugins' });
		publish({ type: 'step_completed' });
		buf = await readUntil(reader, 'step_completed', buf);
		await reader.cancel();
		expect(buf).not.toContain('record_changed');
	});
});
