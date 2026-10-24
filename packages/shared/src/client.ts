/**
 * Typed client built from contracts. `request` does the transport so each
 * caller (SvelteKit load, browser, tests) can supply its own fetch and
 * error handling.
 */
import type { OpContract, OpInput, OpOutput } from './op.ts';
import { pathParams } from './op.ts';

export interface Request {
	method: string;
	/** Path below /api, with params substituted, and query string for GET/DELETE. */
	url: string;
	body?: unknown;
}

export type Transport = (req: Request) => Promise<unknown>;

type ContractTree = { [k: string]: OpContract | ContractTree };

export type Client<T extends ContractTree> = {
	[K in keyof T]: T[K] extends OpContract
		? (input: OpInput<T[K]>) => Promise<OpOutput<T[K]>>
		: T[K] extends ContractTree
			? Client<T[K]>
			: never;
};

export function buildRequest(c: OpContract, input: Record<string, unknown>): Request {
	const rest: Record<string, unknown> = { ...input };
	let url = c.path;
	for (const p of pathParams(c.path)) {
		url = url.replace(`:${p}`, encodeURIComponent(String(rest[p])));
		delete rest[p];
	}
	if (c.method === 'GET' || c.method === 'DELETE') {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(rest)) {
			if (v === undefined || v === null) continue;
			for (const item of Array.isArray(v) ? v : [v]) qs.append(k, String(item));
		}
		const s = qs.toString();
		return { method: c.method, url: s ? `${url}?${s}` : url };
	}
	return { method: c.method, url, body: rest };
}

export function createClient<T extends ContractTree>(tree: T, transport: Transport): Client<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(tree)) {
		out[k] =
			'path' in v && 'method' in v
				? (input: Record<string, unknown>) => transport(buildRequest(v as OpContract, input ?? {}))
				: createClient(v as ContractTree, transport);
	}
	return out as Client<T>;
}

/** URL of an operation below /api, for links and downloads (`produces` contracts). */
export function opUrl(c: OpContract, input: Record<string, unknown> = {}): string {
	return `/api${buildRequest(c, input).url}`;
}
