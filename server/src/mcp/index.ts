/** MCP over Streamable HTTP at /mcp, built from the operation list. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { matchesPattern, OpalError } from '@opal/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requestBase } from '../auth/base-url.ts';
import { MCP_RESOURCE_METADATA } from '../auth/oauth.ts';
import type { Actor } from '../context.ts';
import type { Db } from '../db/client.ts';
import { errorResponse, type Impl, type ResolveActor, runOp } from '../registry.ts';

const toolName = (opName: string) => opName.replaceAll('.', '_');

/**
 * Read by MCP clients once per connection. Rules that apply across tools live here; rules for
 * one field live in that field's description, where an agent filling it in sees them.
 */
export const INSTRUCTIONS = [
	'OPAL is the record of what an organization builds: parts, stock, purchasing, procedures, work orders, issues, risks and requirements. People sign and rely on these records, so write only what you can stand behind.',
	'',
	'- Sources. Every value comes from a source: a file, a drawing, the CAD model, a receipt, or the person. Say in the description which one. When the source is unknown, leave the field empty and write "source unconfirmed". Never fill a size, part number or supplier from general knowledge.',
	'- Scope. Create a part only when it was ordered, is in stock, or is in the CAD assembly. A part that is merely mentioned is not created.',
	'- Bulk edits. Before renaming or editing more than a handful of records, show the list, before and after, and wait for approval. A question about a convention is not approval to apply it.',
	'- Before creating parts, call parts_schema for the tiers, categories, custom fields and numbering format.',
	'- Part numbers are never reused, so a part created by mistake keeps its number. Search for an existing part (parts_list, search_query) before creating one.'
].join('\n');

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

	const server = new Server({ name: 'opal', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
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
				// Tells an MCP client where to sign in (RFC 9728).
				'WWW-Authenticate': `Bearer realm="opal", resource_metadata="${requestBase(c).base}${MCP_RESOURCE_METADATA}"`
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
