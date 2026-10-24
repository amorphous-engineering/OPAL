/** The actor behind a request, and the context every handler receives. */
import type { Gate } from '@opal/shared';
import type { Db } from './db/client.ts';

export type Actor =
	| { kind: 'anonymous' }
	| { kind: 'user'; userId: number; isAdmin: boolean; sessionId: number }
	| { kind: 'token'; userId: number; isAdmin: boolean; tokenId: number }
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
	cookies?: CookieJar;
	request?: RequestInfo;
}

export function holdsGate(actor: Actor, _gate: Gate): boolean {
	if (actor.kind === 'system') return true;
	if (actor.kind === 'anonymous') return false;
	// Phase 0: admins hold every gate and other users hold every gate too.
	// Role-granted gates arrive with the roles port.
	return true;
}

export function actorUserId(actor: Actor): number | null {
	return actor.kind === 'user' || actor.kind === 'token' ? actor.userId : null;
}
