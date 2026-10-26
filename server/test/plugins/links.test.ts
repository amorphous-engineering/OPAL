import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Actor } from '../../src/context.ts';
import { auditLog, issue, project } from '../../src/db/schema/index.ts';
import { addPlugin, setup } from './helpers.ts';

async function withRecords() {
	const s = await setup();
	const now = new Date().toISOString();
	const p = s.db.insert(project).values({ name: 'P', code: 'P', createdAt: now, updatedAt: now } as never).returning().get() as { id: number };
	const i = s.db.insert(issue).values({ projectId: p.id, issueNumber: 'IT-0000000001', title: 'Leak', createdAt: now, updatedAt: now } as never).returning().get() as { id: number };
	const plug = addPlugin(s.db, 'kaneo');
	const asPlugin: Actor = plug.actor;
	const call = (method: string, path: string, body?: unknown) =>
		s.app.request(`/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	return { ...s, issueId: i.id, projectId: p.id, asPlugin, call };
}

const link = (issueId: number, over: object = {}) => ({
	entityType: 'issue',
	entityId: issueId,
	externalId: 'T-1',
	url: 'https://kaneo.example/t/1',
	label: 'T-1',
	...over
});

describe('external links', () => {
	test('a plugin sets, updates and removes its link, and the list shows the plugin name', async () => {
		const s = await withRecords();
		s.setActor(s.asPlugin);
		const made = await s.call('PUT', '/links', link(s.issueId));
		expect(made.status).toBe(200);
		expect(await made.json()).toMatchObject({ plugin: 'kaneo', pluginName: 'KANEO', externalId: 'T-1' });
		const again = await s.call('PUT', '/links', link(s.issueId, { url: 'https://kaneo.example/t/1b', label: null }));
		expect(await again.json()).toMatchObject({ url: 'https://kaneo.example/t/1b', label: null });

		s.setActor({ kind: 'user', userId: s.person.id, isAdmin: true, sessionId: 1 });
		const list = await (await s.call('GET', `/links?entityType=issue&entityId=${s.issueId}`)).json();
		expect(list.items).toHaveLength(1);
		expect(list.items[0]).toMatchObject({ pluginName: 'KANEO', url: 'https://kaneo.example/t/1b' });

		s.setActor(s.asPlugin);
		const gone = await s.call('DELETE', `/links?entityType=issue&entityId=${s.issueId}&externalId=T-1`);
		expect(await gone.json()).toEqual({ ok: true });
		s.setActor({ kind: 'user', userId: s.person.id, isAdmin: true, sessionId: 1 });
		expect((await (await s.call('GET', `/links?entityType=issue&entityId=${s.issueId}`)).json()).items).toEqual([]);
		const audits = s.db.select().from(auditLog).all().filter((r) => r.entity === 'external_link');
		expect(audits.map((a) => a.action)).toEqual(['create', 'update', 'delete']);
	});

	test('a person may not set or remove a link', async () => {
		const s = await withRecords();
		const set = await s.call('PUT', '/links', link(s.issueId));
		expect(set.status).toBe(403);
		const rm = await s.call('DELETE', `/links?entityType=issue&entityId=${s.issueId}&externalId=T-1`);
		expect(rm.status).toBe(403);
	});

	test('a link needs an existing record', async () => {
		const s = await withRecords();
		s.setActor(s.asPlugin);
		expect((await s.call('PUT', '/links', link(9999))).status).toBe(404);
		expect((await s.call('PUT', '/links', link(s.projectId, { entityType: 'project' }))).status).toBe(200);
	});

	test('a plugin token outside its scope cannot call other operations, and a plugin cannot take another plugin\'s link', async () => {
		const s = await withRecords();
		s.setActor(s.asPlugin);
		expect((await s.call('GET', '/issues')).status).toBe(403);
		await s.call('PUT', '/links', link(s.issueId));
		const other = addPlugin(s.db, 'other');
		s.setActor(other.actor);
		await s.call('PUT', '/links', link(s.issueId));
		s.setActor({ kind: 'user', userId: s.person.id, isAdmin: true, sessionId: 1 });
		const list = await (await s.call('GET', `/links?entityType=issue&entityId=${s.issueId}`)).json();
		expect(list.items.map((l: { plugin: string }) => l.plugin)).toEqual(['kaneo', 'other']);
	});

	test('MCP lists a scoped token only the tools in its scope', async () => {
		const s = await withRecords();
		s.setActor({ ...s.asPlugin, scopes: { ops: ['plugins.links.list'], events: [] } });
		const transport = new StreamableHTTPClientTransport(new URL('http://opal.test/mcp'), {
			fetch: ((input: RequestInfo | URL, init?: RequestInit) => s.app.fetch(new Request(input, init))) as typeof fetch
		});
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(transport);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(['plugins_links_list']);
		await client.close();
	});
});
