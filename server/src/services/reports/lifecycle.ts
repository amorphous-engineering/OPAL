/**
 * Instance lifecycle: demo database switching and factory reset.
 *
 * One instance = one organization. The demo is a separate sibling database file
 * (`demo.<name>`) with its own attachments folder (`demo.<name>-attachments`). Entering it
 * switches the running server to that file; exiting switches back and deletes it. Factory
 * reset wipes the real database and its attachments back to first-run state.
 *
 * How the switch works. Every part of the server holds the one `Db` object it got from
 * `createApp`. To change the database under all of them without touching core, the switch
 * REPLACES THE OWN PROPERTIES of that object (`session`, `dialect`, `$client`, ...) with those
 * of a newly opened database, then closes the old connection. The object keeps its identity.
 *
 * The switch runs in the write queue (`serialized`) after the operation that asked for it has
 * committed: the operation's own transaction is on the old connection and must end there.
 *
 * The attachments folder follows `OPAL_DATA_DIR`, which blobs and avatars read on every call,
 * so the demo sets it to its own folder and exit restores the original value. `OPAL_DB_FILE`
 * is set to the active database file; core `dbPath()` should honor it (see the report).
 *
 * In-flight requests during a switch may finish against the previous database. The server
 * always starts on the real database, so a crash in demo mode ends in the real one.
 */
import { Database } from 'bun:sqlite';
import { type LifecycleState, FACTORY_RESET_WORD, OpalError, conflict } from '@opal/shared';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SESSION_COOKIE } from '../../auth/tokens.ts';
import { type Ctx, actorUserId } from '../../context.ts';
import { type Db, openDb } from '../../db/client.ts';
import { loadDevSchema } from '../../db/dev.ts';
import { authSetting, notification, part, user } from '../../db/schema/index.ts';
import { serialized } from '../../registry.ts';
import { insert, update } from '../../write.ts';
import { startSession } from '../auth/sessions.ts';
import { upsertProfile } from '../org/profiles.ts';
import { ensureFts } from '../platform/search.ts';
import { storeNumbersAtFullWidth } from '../../db/full-width-numbers.ts';
import { renameCheckboxFields } from '../../db/boolean-fields.ts';
import { buildDemoContent } from './demo.ts';

export const DEMO_PREFIX = 'demo.';

interface Home {
	dbPath: string;
	/** Values of the environment variables before any demo, restored on exit. */
	env: { OPAL_DATA_DIR: string | undefined; OPAL_DB_FILE: string | undefined };
	demo: boolean;
}

const homes = new WeakMap<Db, Home>();

const fileOf = (db: Db): string => (db.$client as Database).filename;

function home(db: Db): Home {
	let h = homes.get(db);
	if (!h) {
		const dbPath = fileOf(db);
		if (!dbPath || dbPath === ':memory:') {
			throw conflict('lifecycle_unavailable', 'The demo and factory reset need a database file');
		}
		h = {
			dbPath,
			env: { OPAL_DATA_DIR: process.env.OPAL_DATA_DIR, OPAL_DB_FILE: process.env.OPAL_DB_FILE },
			demo: false
		};
		homes.set(db, h);
	}
	return h;
}

export const demoPath = (h: Home) => join(dirname(h.dbPath), `${DEMO_PREFIX}${basename(h.dbPath)}`);
export const demoAttachments = (h: Home) => `${demoPath(h)}-attachments`;
/** The real data folder: where blobs and avatars of the real database live. */
const realDataDir = (h: Home) => h.env.OPAL_DATA_DIR ?? dirname(h.dbPath);

function setEnv(name: 'OPAL_DATA_DIR' | 'OPAL_DB_FILE', value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function unlinkSqlite(path: string): void {
	for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
}

/** Open a database file with the schema applied. Dev-schema mode builds it from schema.ts. */
async function openFile(path: string): Promise<Db> {
	const db = process.env.OPAL_DEV_SCHEMA === '1' ? await (await loadDevSchema()).openSchemaDb(path) : openDb(path);
	ensureFts(db);
	// A database opened here goes live without createApp (exit demo, factory reset).
	storeNumbersAtFullWidth(db);
	renameCheckboxFields(db);
	return db;
}

/** Make `live` (the object the server holds) run on `next`'s connection; close the old one. */
function swap(live: Db, next: Db): void {
	const old = live.$client as Database;
	Object.assign(live, Object.fromEntries(Object.entries(next)));
	try {
		old.close();
	} catch {
		/* already closed */
	}
}

export function lifecycleState(ctx: Pick<Ctx, 'db'>): LifecycleState {
	const h = home(ctx.db);
	return {
		demoActive: h.demo,
		demoFileExists: existsSync(demoPath(h)),
		demoDbPath: demoPath(h)
	};
}

// ---------------------------------------------------------------- enter

/** Sign-in settings travel with the operator so an SSO deployment is not dropped onto a password login. */
function copyAuthSettings(from: Db, to: Db): void {
	const ctx = { db: to, actor: { kind: 'system' }, op: 'reports.lifecycle.enterDemo' } as Ctx;
	for (const row of from.select().from(authSetting).all()) {
		if (row.value === null || to.select().from(authSetting).where(eq(authSetting.key, row.key)).get()) continue;
		insert(ctx, authSetting, { key: row.key, value: row.value });
	}
}

/** The operator as an active admin of the demo database. */
function upsertOperator(demo: Ctx, operator: typeof user.$inferSelect) {
	const byEmail = operator.email ? demo.db.select().from(user).where(eq(user.email, operator.email)).get() : undefined;
	const match = byEmail ?? demo.db.select().from(user).where(eq(user.name, operator.name)).get();
	let row: typeof user.$inferSelect;
	if (!match) {
		let username = operator.username;
		for (let n = 2; demo.db.select().from(user).where(eq(user.username, username)).get(); n++) {
			username = `${operator.username}${n}`;
		}
		row = insert(demo, user, {
			username,
			name: operator.name,
			email: operator.email,
			// Same operator, same credential: sign-in keeps working if the session lapses.
			passwordHash: operator.passwordHash,
			isActive: true,
			isAdmin: true
		});
	} else {
		row = update(demo, user, match.id, { isActive: true, isAdmin: true });
	}
	upsertProfile(demo, row.id, { needsOnboarding: false, needsProfileSetup: false });
	return row;
}

/** Give the operator the build lead's inbox so the bell is not empty. Best effort. */
function mirrorNotifications(demo: Ctx, operator: { id: number }): void {
	try {
		const lead = demo.db.select().from(user).where(eq(user.username, 'build')).get();
		if (!lead || lead.id === operator.id) return;
		if (demo.db.select().from(notification).where(eq(notification.userId, operator.id)).get()) return;
		for (const n of demo.db.select().from(notification).where(eq(notification.userId, lead.id)).all()) {
			const { id: _id, ...rest } = n;
			demo.db
				.insert(notification)
				.values({ ...rest, userId: operator.id, actorId: n.actorId === operator.id ? null : n.actorId })
				.run();
		}
	} catch (e) {
		console.warn('Could not mirror demo notifications', e);
	}
}

export async function enterDemo(ctx: Ctx): Promise<LifecycleState> {
	const h = home(ctx.db);
	if (h.demo) return lifecycleState(ctx);
	const operatorId = actorUserId(ctx.actor);
	const operator = operatorId === null ? undefined : ctx.db.select().from(user).where(eq(user.id, operatorId)).get();

	mkdirSync(demoAttachments(h), { recursive: true });
	const demoDb = await openFile(demoPath(h));
	const demoCtx: Ctx = { ...ctx, db: demoDb, actor: { kind: 'system' } };
	// Freshness is a property of the content, not the file: an interrupted first build leaves a
	// blank file, and the next entry builds it again.
	const fresh = !demoDb.select({ id: user.id }).from(user).limit(1).get() && !demoDb.select({ id: part.id }).from(part).limit(1).get();
	if (fresh) {
		buildDemoContent(demoDb);
		copyAuthSettings(ctx.db, demoDb);
	}
	if (operator) {
		const row = upsertOperator(demoCtx, operator);
		mirrorNotifications(demoCtx, row);
		// Sessions live per database: mint one in the demo so the operator stays signed in.
		startSession({ ...demoCtx, cookies: ctx.cookies, request: ctx.request }, row, 'demo');
	}

	h.demo = true;
	void serialized(async () => {
		setEnv('OPAL_DATA_DIR', demoAttachments(h));
		setEnv('OPAL_DB_FILE', demoPath(h));
		swap(ctx.db, demoDb);
	});
	return { demoActive: true, demoFileExists: true, demoDbPath: demoPath(h) };
}

// ---------------------------------------------------------------- exit and delete

function removeDemoFiles(h: Home): void {
	unlinkSqlite(demoPath(h));
	rmSync(demoAttachments(h), { recursive: true, force: true });
}

export async function exitDemo(ctx: Ctx, deleteFiles = true): Promise<LifecycleState> {
	const h = home(ctx.db);
	if (!h.demo) return lifecycleState(ctx);
	const real = await openFile(h.dbPath);
	h.demo = false;
	// Demo sessions mean nothing in the real database.
	ctx.cookies?.delete(SESSION_COOKIE);
	void serialized(async () => {
		setEnv('OPAL_DATA_DIR', h.env.OPAL_DATA_DIR);
		setEnv('OPAL_DB_FILE', h.env.OPAL_DB_FILE);
		swap(ctx.db, real);
		if (deleteFiles) removeDemoFiles(h);
	});
	return { demoActive: false, demoFileExists: !deleteFiles, demoDbPath: demoPath(h) };
}

export function deleteDemo(ctx: Pick<Ctx, 'db'>): LifecycleState {
	const h = home(ctx.db);
	if (h.demo) throw conflict('demo_active', 'Cannot delete the demo database while it is active. Exit the demo first.');
	removeDemoFiles(h);
	return lifecycleState(ctx);
}

// ---------------------------------------------------------------- factory reset

export function factoryReset(ctx: Ctx, confirm: string): void {
	if (confirm.trim() !== FACTORY_RESET_WORD) {
		throw new OpalError(422, 'invalid_input', 'Invalid input', { confirm: `Type ${FACTORY_RESET_WORD} to confirm` });
	}
	const h = home(ctx.db);
	console.warn('FACTORY RESET initiated');
	ctx.cookies?.delete(SESSION_COOKIE);
	void serialized(async () => {
		const live = ctx.db;
		const dataRoot = realDataDir(h);
		// Back to the real folder first, so every path below is the real one.
		setEnv('OPAL_DATA_DIR', h.env.OPAL_DATA_DIR);
		setEnv('OPAL_DB_FILE', h.env.OPAL_DB_FILE);
		h.demo = false;
		(live.$client as Database).close();
		removeDemoFiles(h);
		unlinkSqlite(h.dbPath);
		// Attachments: the content-addressed blobs and the avatars.
		for (const sub of ['blobs', 'avatars']) rmSync(join(dataRoot, sub), { recursive: true, force: true });
		swap(live, await openFile(h.dbPath));
	});
}

/** For tests: forget what was learned about a database. */
export function forgetLifecycle(db: Db): void {
	homes.delete(db);
}
