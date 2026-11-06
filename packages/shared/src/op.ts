/**
 * Operation contracts. Every action OPAL exposes is one contract. The server
 * binds a handler to it; HTTP routes, MCP tools and the typed client are all
 * derived from the same contract.
 */
import { z } from 'zod';
import type { Gate } from './gates.ts';
import { MAX_TOKEN } from './limits.ts';

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
	/**
	 * A non-JSON response (CSV, SVG). The output schema is then `z.string()` and
	 * the handler returns the body. Link to it with `opUrl()`; do not fetch it as JSON.
	 */
	produces?: 'text/csv' | 'image/svg+xml' | 'text/plain';
	/** File name for a download (sets Content-Disposition: attachment). */
	filename?: string;
}

const stripped = new WeakMap<object, z.ZodType>();

/**
 * The same schema with no maximum lengths. Limits are for what people send in. An output check
 * catches server bugs and must not refuse a value the server accepted earlier, under a limit that
 * did not exist then, or a record would stop opening.
 */
export function withoutLimits<T extends z.ZodType>(schema: T): T {
	const seen = stripped.get(schema);
	if (seen) return seen as T;
	const def = (schema as unknown as { _zod: { def: Record<string, any> } })._zod.def;
	// A lazy schema can refer to itself: resolve it when it is first used.
	if (def.type === 'lazy') {
		const lazy = z.lazy(() => withoutLimits(def.getter()));
		stripped.set(schema, lazy);
		return lazy as unknown as T;
	}
	const next: Record<string, any> = {};
	let changed = false;
	const child = (key: string, value: z.ZodType) => {
		const out = withoutLimits(value);
		next[key] = out;
		if (out !== value) changed = true;
	};
	const checks = (def.checks ?? []) as { _zod: { def: { check: string } } }[];
	const kept = checks.filter((c) => c._zod.def.check !== 'max_length');
	if (kept.length !== checks.length) {
		next.checks = kept;
		changed = true;
	}
	for (const key of ['element', 'innerType', 'keyType', 'valueType', 'in', 'out', 'left', 'right', 'catchall', 'rest']) {
		if (def[key]) child(key, def[key]);
	}
	if (def.type === 'object') {
		const shape: Record<string, z.ZodType> = {};
		for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) {
			shape[k] = withoutLimits(v);
			if (shape[k] !== v) changed = true;
		}
		next.shape = shape;
	}
	for (const key of ['options', 'items']) {
		if (!def[key]) continue;
		next[key] = (def[key] as z.ZodType[]).map((o) => withoutLimits(o));
		if ((next[key] as z.ZodType[]).some((o, i) => o !== def[key][i])) changed = true;
	}
	const out = changed ? (schema.clone({ ...def, ...next } as never) as T) : schema;
	stripped.set(schema, out);
	return out;
}

export function op<I extends z.ZodType, O extends z.ZodType>(c: OpContract<I, O>): OpContract<I, O> {
	return { ...c, output: withoutLimits(c.output) };
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
	cursor: z.string().max(MAX_TOKEN).optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100)
});

export function zPage<T extends z.ZodType>(item: T) {
	return z.object({ items: z.array(item), next: z.string().nullable() });
}
