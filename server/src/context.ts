/** The actor behind a request, and the context every handler receives. */
import type { Db } from './db/client.ts';

export type Actor =
	| { kind: 'anonymous' }
	| { kind: 'user'; userId: number; isAdmin: boolean; sessionId: number }
	| {
			kind: 'token';
			userId: number;
			isAdmin: boolean;
			tokenId: number;
			/** Limits of a scoped token (a plugin token). Absent: everything its user may do. */
			scopes?: { ops: string[]; events: string[] };
		}
	| { kind: 'system' };

export interface CookieOptions {
	maxAge?: number;
	expires?: Date;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: 'Strict' | 'Lax' | 'None';
	path?: string;
}

/** Cookie access for operations called over HTTP. Absent for MCP calls. */
export interface CookieJar {
	get(name: string): string | undefined;
	set(name: string, value: string, opts?: CookieOptions): void;
	delete(name: string, opts?: Pick<CookieOptions, 'path' | 'secure'>): void;
	/** True when the request reached the server over HTTPS. */
	secure: boolean;
}

export interface RequestInfo {
	userAgent: string | null;
	ip: string | null;
}

export interface Ctx {
	db: Db;
	actor: Actor;
	/** Name of the running operation; recorded on every audit row. */
	op: string;
	/** Unique per operation call; recorded on every audit row the call writes. */
	invocation?: string;
	cookies?: CookieJar;
	request?: RequestInfo;
	/**
	 * Run fn as the write of this operation. Handlers of operations bound with `verifyFirst`
	 * check credentials first and call this to enter the write queue; for every other
	 * operation the registry already holds the transaction and fn simply runs.
	 */
	write?: <T>(fn: () => T) => Promise<T>;
}

export function actorUserId(actor: Actor): number | null {
	return actor.kind === 'user' || actor.kind === 'token' ? actor.userId : null;
}
