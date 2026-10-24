/**
 * Binds handlers to contracts and mounts them on Hono. Each implemented
 * contract becomes one route below /api; src/mcp reads the same list.
 */
import {
	type ApiErrorBody,
	OpalError,
	type OpContract,
	type OpInput,
	type OpOutput,
	forbidden,
	unauthenticated
} from '@opal/shared';
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { z } from 'zod';
import { type Actor, type CookieJar, type Ctx, holdsGate, type RequestInfo } from './context.ts';
import type { Db } from './db/client.ts';

export interface Impl<C extends OpContract = OpContract> {
	contract: C;
	handler: (ctx: Ctx, input: z.output<C['input']>) => OpOutput<C> | Promise<OpOutput<C>>;
}

export function implement<C extends OpContract>(contract: C, handler: Impl<C>['handler']): Impl<C> {
	return { contract, handler };
}

/**
 * SQLite has one connection and handlers can await, so two write operations
 * could interleave inside one transaction. Writes run one at a time.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = writeQueue.then(fn, fn);
	writeQueue = run.catch(() => undefined);
	return run;
}

export function checkAccess(contract: OpContract, actor: Actor): void {
	if (contract.access === 'public') return;
	if (actor.kind === 'anonymous') throw unauthenticated();
	if (contract.humanOnly && actor.kind === 'token') {
		throw forbidden('This action needs a signed-in person, not an API token');
	}
	if (contract.access !== 'signed-in' && !holdsGate(actor, contract.access)) throw forbidden();
}

function zodFields(err: z.ZodError): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const issue of err.issues) fields[issue.path.join('.') || '_'] = issue.message;
	return fields;
}

/**
 * Run one operation: validate input, check access, run the handler (in a
 * transaction for writes), validate output. Used by HTTP and MCP alike.
 */
export async function runOp<C extends OpContract>(
	impl: Impl<C>,
	db: Db,
	actor: Actor,
	rawInput: unknown,
	http?: { cookies: CookieJar; request: RequestInfo }
): Promise<OpOutput<C>> {
	const { contract } = impl;
	checkAccess(contract, actor);
	const parsed = contract.input.safeParse(rawInput);
	if (!parsed.success) {
		throw new OpalError(422, 'invalid_input', 'Invalid input', zodFields(parsed.error));
	}
	const ctx: Ctx = { db, actor, op: contract.name, ...http };
	const exec = async () => contract.output.parse(await impl.handler(ctx, parsed.data as z.output<C['input']>)) as OpOutput<C>;
	if (contract.method === 'GET') return exec();
	return serialized(async () => {
		db.run(sql`BEGIN IMMEDIATE`);
		try {
			const out = await exec();
			db.run(sql`COMMIT`);
			return out;
		} catch (e) {
			db.run(sql`ROLLBACK`);
			throw e;
		}
	});
}

export type ResolveActor = (c: Context) => Actor | Promise<Actor>;

export function mountOps(app: Hono, impls: Impl[], db: Db, resolveActor: ResolveActor): void {
	const seen = new Set<string>();
	for (const impl of impls) {
		const c = impl.contract;
		if (seen.has(c.name)) throw new Error(`Duplicate operation ${c.name}`);
		seen.add(c.name);
		app.on(c.method, `/api${c.path}`, async (hc) => {
			let input: Record<string, unknown> = {};
			if (c.method === 'GET' || c.method === 'DELETE') {
				input = Object.fromEntries(new URL(hc.req.url).searchParams);
			} else if (hc.req.header('content-type')?.includes('application/json')) {
				input = (await hc.req.json()) as Record<string, unknown>;
			}
			Object.assign(input, hc.req.param());
			const out = await runOp(impl, db, await resolveActor(hc), input as OpInput<typeof c>, {
				cookies: cookieJar(hc),
				request: {
					userAgent: hc.req.header('user-agent') ?? null,
					ip: hc.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
				}
			});
			return hc.json(out as object, c.method === 'POST' && c.name.endsWith('.create') ? 201 : 200);
		});
	}
}

export function errorResponse(err: unknown): { status: number; body: ApiErrorBody } {
	if (err instanceof OpalError) return { status: err.status, body: err.body() };
	// A unique constraint the service did not check first is still a conflict, not a crash.
	if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
		return { status: 409, body: { error: 'duplicate', message: 'A record with this value exists' } };
	}
	console.error(err);
	return { status: 500, body: { error: 'internal', message: 'Internal error' } };
}

function cookieJar(c: Context): CookieJar {
	return {
		get: (name) => getCookie(c, name),
		set: (name, value, opts) => setCookie(c, name, value, { path: '/', ...opts }),
		delete: (name, opts) => deleteCookie(c, name, { path: '/', ...opts }),
		secure: new URL(c.req.url).protocol === 'https:'
	};
}
