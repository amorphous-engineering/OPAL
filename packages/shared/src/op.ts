/**
 * Operation contracts. Every action OPAL exposes is one contract. The server
 * binds a handler to it; HTTP routes, MCP tools and the typed client are all
 * derived from the same contract.
 */
import { z } from 'zod';
import type { Gate } from './gates.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Who may call. `public`: anyone. `signed-in`: any actor. A Gate: an actor
 * whose roles grant it (admins hold every gate).
 */
export type Access = 'public' | 'signed-in' | Gate;

export interface OpContract<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
	/** Dotted name, unique: `parts.create`. The MCP tool name is derived from it. */
	name: string;
	method: HttpMethod;
	/** Hono-style path below /api: `/parts/:id`. Each `:param` is a field of `input`. */
	path: string;
	summary: string;
	input: I;
	output: O;
	access: Access;
	/** Expose as an MCP tool. */
	mcp: boolean;
	/** Refused for API-token actors: authoritative human acts such as sign-offs. */
	humanOnly?: boolean;
}

export function op<I extends z.ZodType, O extends z.ZodType>(c: OpContract<I, O>): OpContract<I, O> {
	return c;
}

export type OpInput<C extends OpContract> = z.input<C['input']>;
export type OpOutput<C extends OpContract> = z.output<C['output']>;

/** Path parameters named in a contract path, in order. */
export function pathParams(path: string): string[] {
	return [...path.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]!);
}

export const zId = z.coerce.number().int().positive();
export const zEmpty = z.object({});
export const zOk = z.object({ ok: z.literal(true) });

/** Cursor pagination, the one list style. `next` is null on the last page. */
export const zPageInput = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100)
});

export function zPage<T extends z.ZodType>(item: T) {
	return z.object({ items: z.array(item), next: z.string().nullable() });
}
