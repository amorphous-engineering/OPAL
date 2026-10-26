import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zPluginManifest, type PluginManifest } from '@opal/shared';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { apiToken, plugin, user } from '../../src/db/schema/index.ts';
import { idleRuntime, setRuntime, type PluginRuntime } from '../../src/services/plugins/runtime.ts';
import { openTestDb } from '../helpers/db.ts';

const ts = () => new Date().toISOString();

/** A database with one person (id 1, admin) and an app whose actor the test sets. */
export async function setup() {
	process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-plugins-'));
	const db: Db = await openTestDb();
	const person = db
		.insert(user)
		.values({ username: 'ann', name: 'Ann', isAdmin: true, createdAt: ts(), updatedAt: ts() })
		.returning()
		.get();
	let actor: Actor = { kind: 'user', userId: person.id, isAdmin: true, sessionId: 1 };
	const app = createApp({ db, resolveActor: () => actor });
	return { db, app, person, setActor: (a: Actor) => (actor = a) };
}

/** Installs a plugin row (enabled) and its user. */
export function addPlugin(db: Db, key: string, over: Partial<PluginManifest> = {}, enabled = true) {
	const manifest = zPluginManifest.parse({ id: key, name: key.toUpperCase(), version: '1.0.0', opal: '>=2.0.0', main: 'a.js', ...over });
	const u = db
		.insert(user)
		.values({ username: `plugin.${key}`, name: manifest.name, createdAt: ts(), updatedAt: ts() })
		.returning()
		.get();
	const row = db
		.insert(plugin)
		.values({ key, source: 'local:/x', sha: 'local', version: '1.0.0', manifest, enabled, userId: u.id, createdAt: ts(), updatedAt: ts() })
		.returning()
		.get();
	// Audit rows reference the token, so it must exist.
	const tok = db
		.insert(apiToken)
		.values({ userId: u.id, name: 't', tokenHash: `h-${key}`, createdAt: ts() })
		.returning()
		.get();
	const actor: Actor = { kind: 'token', userId: u.id, isAdmin: false, tokenId: tok.id, scopes: { ops: ['plugins.links.*'], events: [] } };
	return { row, user: u, actor };
}

/** Stub runtime: plugins in `ports` run on that port. Restore the idle runtime in afterEach. */
export function stubRuntime(ports: Record<string, number | null>): void {
	const r: PluginRuntime = { ...idleRuntime, port: (k) => ports[k] ?? null };
	setRuntime(r);
}
export const restoreRuntime = () => setRuntime(idleRuntime);
