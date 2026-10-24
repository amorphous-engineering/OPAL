import { now } from '@opal/shared';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { apiToken, appSetting, user } from '../../src/db/schema/index.ts';
import { openTestDb } from '../helpers/db.ts';

/** A database, an app whose actor is chosen per call, and a few users. */
export async function setup() {
	const db: Db = await openTestDb();
	let current: Actor = { kind: 'system' };
	const app = createApp({ db, resolveActor: () => current });

	function makeUser(username: string, opts: { admin?: boolean } = {}) {
		const ts = now();
		const row = db
			.insert(user)
			.values({ username, name: username, email: `${username}@x.local`, isAdmin: opts.admin ?? false, createdAt: ts, updatedAt: ts })
			.returning()
			.get();
		const person: Actor = { kind: 'user', userId: row.id, isAdmin: row.isAdmin, sessionId: 0 };
		const tokenRow = db
			.insert(apiToken)
			.values({ userId: row.id, name: 't', tokenHash: `h-${username}`, createdAt: ts })
			.returning()
			.get();
		const token: Actor = { kind: 'token', userId: row.id, isAdmin: row.isAdmin, tokenId: tokenRow.id };
		return { id: row.id, person, token };
	}

	async function call(as: Actor | null, method: string, path: string, body?: unknown) {
		current = as ?? { kind: 'anonymous' };
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
		return { status: res.status, json, text };
	}

	/** Shorthand as the system actor. */
	const api = (method: string, path: string, body?: unknown) => call({ kind: 'system' }, method, path, body);
	const create = async (body: Record<string, unknown>) => {
		const r = await api('POST', '/parts', { tier: 1, ...body });
		if (r.status !== 201) throw new Error(`create failed ${r.status} ${r.text}`);
		return r.json;
	};
	const activate = async (id: number, cause?: string) => {
		const r = await api('POST', `/parts/${id}/activate`, cause ? { cause } : {});
		if (r.status !== 200) throw new Error(`activate failed ${r.status} ${r.text}`);
		return r.json;
	};

	function setSetting(key: string, value: string) {
		const ts = now();
		db.insert(appSetting).values({ key, value, createdAt: ts, updatedAt: ts }).run();
	}
	/** Store a project configuration, as the legacy import does (snake_case keys). */
	function configureProject(config: Record<string, unknown>) {
		setSetting('project_config', JSON.stringify({ name: 'Test', description: '', ...config }));
	}

	return { db, app, call, api, create, activate, makeUser, setSetting, configureProject };
}
