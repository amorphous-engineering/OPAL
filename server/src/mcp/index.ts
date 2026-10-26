/** MCP over Streamable HTTP at /mcp, built from the operation list. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { matchesPattern, OpalError } from '@opal/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Actor } from '../context.ts';
import type { Db } from '../db/client.ts';
import { errorResponse, type Impl, type ResolveActor, runOp } from '../registry.ts';

const toolName = (opName: string) => opName.replaceAll('.', '_');

function errorText(e: unknown): string {
	if (e instanceof OpalError) {
		const fields = e.fields ? ` ${JSON.stringify(e.fields)}` : '';
		return `${e.message}${fields}`;
	}
	return errorResponse(e).body.message;
}

function buildServer(impls: Impl[], db: Db, actor: Actor): Server {
	const tools = new Map<string, Impl>();
	// A scoped token (a plugin) sees only the tools it may call; runOp refuses the rest anyway.
	const scopes = actor.kind === 'token' ? actor.scopes : undefined;
	for (const impl of impls) {
		if (impl.contract.mcp && (!scopes || matchesPattern(scopes.ops, impl.contract.name))) {
			tools.set(toolName(impl.contract.name), impl);
		}
	}

	const server = new Server({ name: 'opal', version: '1.0.0' }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [...tools].map(([name, impl]) => ({
			name,
			description: impl.contract.summary,
			inputSchema: z.toJSONSchema(impl.contract.input, { io: 'input' }) as {
				type: 'object';
				[k: string]: unknown;
			}
		}))
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const impl = tools.get(req.params.name);
		if (!impl) {
			return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool ${req.params.name}` }] };
		}
		try {
			const out = await runOp(impl, db, actor, req.params.arguments ?? {});
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(out) }],
				// structuredContent must be an object; wrap anything else.
				structuredContent: (out !== null && typeof out === 'object' && !Array.isArray(out)
					? out
					: { result: out }) as Record<string, unknown>
			};
		} catch (e) {
			return { isError: true, content: [{ type: 'text' as const, text: errorText(e) }] };
		}
	});
	return server;
}

export function mountMcp(app: Hono, impls: Impl[], db: Db, resolveActor: ResolveActor): void {
	app.all('/mcp', async (c) => {
		const actor = await resolveActor(c);
		if (actor.kind === 'anonymous') {
			return c.json({ error: 'unauthenticated', message: 'Sign in required' }, 401, {
				'WWW-Authenticate': 'Bearer realm="opal"'
			});
		}
		// Stateless: a fresh server and transport per request.
		const server = buildServer(impls, db, actor);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true
		});
		await server.connect(transport);
		try {
			return await transport.handleRequest(c.req.raw);
		} finally {
			// Close after the response body is ready; JSON mode has no open stream.
			void server.close();
		}
	});
}
