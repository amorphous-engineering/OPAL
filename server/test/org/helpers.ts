import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { session, user } from '../../src/db/schema/index.ts';
import { now } from '@opal/shared';
import { openTestDb } from '../helpers/db.ts';

export interface Person {
	id: number;
	actor: Actor;
}

/** A database, an app whose actor is chosen per call, and users to act as. */
export async function setup() {
	const db: Db = await openTestDb();
	let current: Actor = { kind: 'system' };
	const app = createApp({ db, resolveActor: () => current });

	function makeUser(username: string, opts: { admin?: boolean; active?: boolean } = {}): Person {
		const ts = now();
		const row = db
			.insert(user)
			.values({
				username,
				name: username,
				email: `${username}@x.local`,
				isAdmin: opts.admin ?? false,
				isActive: opts.active ?? true,
				createdAt: ts,
				updatedAt: ts
			})
			.returning()
			.get();
		const actor: Actor = { kind: 'user', userId: row.id, isAdmin: row.isAdmin, sessionId: 0 };
		return { id: row.id, actor };
	}

	async function call(as: Person | Actor | null, method: string, path: string, body?: unknown) {
		current = as === null ? { kind: 'anonymous' } : 'actor' in as ? as.actor : as;
		const res = await app.request(`/api${path}`, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const text = await res.text();
		let json: any = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* not JSON */
		}
		return { status: res.status, json, text, headers: res.headers };
	}

	function addSession(userId: number) {
		const ts = now();
		return db
			.insert(session)
			.values({ userId, tokenHash: `h${Math.random()}`, method: 'password', expiresAt: '2999-01-01T00:00:00.000Z', createdAt: ts })
			.returning()
			.get();
	}

	return { db, app, call, makeUser, addSession };
}
