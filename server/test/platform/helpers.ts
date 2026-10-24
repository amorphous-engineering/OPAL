import { Hono } from 'hono';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { user } from '../../src/db/schema/index.ts';
import { errorResponse, mountOps } from '../../src/registry.ts';
import { platformImpls } from '../../src/ops/platform.ts';
import { mountFiles } from '../../src/services/platform/files.ts';
import { openTestDb } from '../helpers/db.ts';

/** A database with n users, and an app with the platform operations and file routes. */
export async function setup(userCount = 3) {
	process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-platform-'));
	const db: Db = await openTestDb();
	const users = Array.from({ length: userCount }, (_, i) =>
		db
			.insert(user)
			.values({
				username: `u${i + 1}`,
				name: `User ${i + 1}`,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			})
			.returning()
			.get()
	);
	let actor: Actor = { kind: 'user', userId: users[0]!.id, isAdmin: false, sessionId: 1 };
	const as = (i: number) => {
		actor = { kind: 'user', userId: users[i]!.id, isAdmin: false, sessionId: 1 };
	};
	const resolveActor = () => actor;
	const app = new Hono();
	app.onError((err, c) => {
		const { status, body } = errorResponse(err);
		return c.json(body, status as 400);
	});
	mountOps(app, platformImpls, db, resolveActor);
	mountFiles(app, db, { resolveActor });
	const call = (method: string, path: string, body?: unknown) =>
		app.request(`/api${path}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
	return { db, app, call, users, as, setActor: (a: Actor) => (actor = a) };
}
