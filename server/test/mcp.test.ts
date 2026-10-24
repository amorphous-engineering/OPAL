import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { op, zEmpty, zOk } from '@opal/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import type { Actor } from '../src/context.ts';
import { openDb } from '../src/db/client.ts';
import { apiToken, auditLog, user } from '../src/db/schema/index.ts';
import { implement } from '../src/registry.ts';
import { mountMcp } from '../src/mcp/index.ts';

const token: Actor = { kind: 'token', userId: 1, isAdmin: true, tokenId: 1 };

function connect(app: Hono) {
	const transport = new StreamableHTTPClientTransport(new URL('http://opal.test/mcp'), {
		fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
			app.fetch(new Request(input, init))) as typeof fetch
	});
	const client = new Client({ name: 'test', version: '0' });
	return { client, connected: client.connect(transport) };
}

function text(r: unknown): string {
	return (r as { content: { text: string }[] }).content[0]!.text;
}

describe('mcp', () => {
	test('lists tools with JSON schemas and creates a part as the token actor', async () => {
		const db = openDb(':memory:');
		const now = new Date().toISOString();
		db.insert(user).values({ username: 'bot', name: 'Bot', createdAt: now, updatedAt: now }).run();
		db.insert(apiToken).values({ userId: 1, name: 't', tokenHash: 'h', createdAt: now }).run();
		const app = createApp({ db, resolveActor: () => token });
		const { client, connected } = connect(app);
		await connected;

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(['parts_list', 'parts_get', 'parts_create']));
		const create = tools.find((t) => t.name === 'parts_create')!;
		expect(create.inputSchema.type).toBe('object');
		expect(Object.keys(create.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(['name', 'tier'])
		);

		const res = await client.callTool({ name: 'parts_create', arguments: { name: 'Bolt', tier: 1 } });
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(text(res)).name).toBe('Bolt');
		expect((res.structuredContent as { name: string }).name).toBe('Bolt');
		const rows = db.select().from(auditLog).where(eq(auditLog.op, 'parts.create')).all();
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.actorTokenId === 1)).toBe(true);
		await client.close();
	});

	test('invalid input is an error result naming the field', async () => {
		const app = createApp({ db: openDb(':memory:'), resolveActor: () => token });
		const { client, connected } = connect(app);
		await connected;
		const res = await client.callTool({ name: 'parts_create', arguments: { tier: 0 } });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain('name');
		expect(text(res)).toContain('tier');
		await client.close();
	});

	test('anonymous requests get 401 with WWW-Authenticate', async () => {
		const app = createApp({ db: openDb(':memory:'), resolveActor: () => ({ kind: 'anonymous' }) });
		const res = await app.request('/mcp', { method: 'POST', body: '{}' });
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toContain('Bearer');
	});

	test('a humanOnly contract is refused for a token actor', async () => {
		const signoff = op({
			name: 'test.signoff',
			method: 'POST',
			path: '/test/signoff',
			summary: 'Sign off',
			input: zEmpty,
			output: zOk,
			access: 'signed-in',
			mcp: true,
			humanOnly: true
		});
		const impl = implement(signoff, () => ({ ok: true as const }));
		const app = new Hono();
		mountMcp(app, [impl], openDb(':memory:'), () => token);
		const { client, connected } = connect(app);
		await connected;
		const res = await client.callTool({ name: 'test_signoff', arguments: {} });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain('signed-in person');
		await client.close();
	});
});
