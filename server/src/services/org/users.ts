/** Users: admin roster, directory, profile fields, roles, deactivation, activity. */
import {
	type DirectoryEntry,
	type OrgUser,
	OpalError,
	conflict,
	forbidden,
	notFound,
	type zUserCreate,
	type zUserUpdate
} from '@opal/shared';
import { and, desc, eq, getTableName, isNull, like, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Actor, Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import * as schema from '../../db/schema/index.ts';
import { auditLog, role, session, user, userRole, workcenter } from '../../db/schema/index.ts';
import { hashPassword, normalizeUsername, validatePasswordStrength } from '../../auth/tokens.ts';
import { insert, remove, update } from '../../write.ts';
import { removeAvatar, setAvatar, decodeBase64 } from './avatars.ts';
import { orgUser, orgUsers, rolesByUser } from './people.ts';
import { getProfile, profileState, upsertProfile } from './profiles.ts';
import { ADMIN_KEY, ensureSystemRoles } from './roles.ts';

const isAdmin = (a: Actor) => (a.kind === 'user' || a.kind === 'token') && a.isAdmin;
const selfId = (a: Actor) => (a.kind === 'user' || a.kind === 'token' ? a.userId : null);

function row(db: Db, id: number) {
	const r = db.select().from(user).where(eq(user.id, id)).get();
	if (!r) throw notFound(`User ${id}`);
	return r;
}

function activeAdminCount(db: Db): number {
	return db.select({ n: sql<number>`count(*)` }).from(user).where(and(eq(user.isAdmin, true), eq(user.isActive, true))).get()!.n;
}

/** End every live session of a user. Returns how many ended. */
export function revokeAllSessions(db: Db, userId: number): number {
	const live = and(eq(session.userId, userId), isNull(session.revokedAt));
	const n = db.select({ n: sql<number>`count(*)` }).from(session).where(live).get()!.n;
	db.update(session).set({ revokedAt: new Date().toISOString() }).where(live).run();
	return n;
}

export function listUsers(
	ctx: Ctx,
	input: { cursor?: string; limit: number; search?: string; isActive?: boolean }
) {
	const term = input.search?.trim() ? `%${input.search.trim()}%` : null;
	const where = and(
		input.isActive === undefined ? undefined : eq(user.isActive, input.isActive),
		term ? or(like(user.name, term), like(user.username, term), like(user.email, term)) : undefined
	);
	const total = ctx.db.select({ n: sql<number>`count(*)` }).from(user).where(where).get()!.n;
	const offset = Number(input.cursor ?? 0) || 0;
	const rows = ctx.db.select().from(user).where(where).orderBy(sql`lower(${user.name})`, user.id).limit(input.limit + 1).offset(offset).all();
	const page = rows.slice(0, input.limit);
	return {
		items: orgUsers(ctx.db, page),
		next: rows.length > input.limit ? String(offset + input.limit) : null,
		total
	};
}

export function directory(ctx: Ctx): DirectoryEntry[] {
	const rows = ctx.db.select().from(user).where(eq(user.isActive, true)).orderBy(sql`lower(${user.name})`).all();
	return orgUsers(ctx.db, rows).map((u) => ({
		id: u.id,
		name: u.name,
		username: u.username,
		jobTitle: u.jobTitle,
		phone: u.phone,
		workcenter: u.workcenter,
		roles: u.roles,
		avatarUrl: u.avatarUrl
	}));
}

function uniqueUsername(db: Db, raw: string): string {
	const base = normalizeUsername(raw) || 'user';
	let candidate = base;
	for (let n = 2; db.select({ id: user.id }).from(user).where(eq(user.username, candidate)).get(); n++) {
		candidate = `${base.slice(0, 64 - String(n).length)}${n}`;
	}
	return candidate;
}

function checkEmailFree(db: Db, email: string, exceptId?: number) {
	const clash = db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
	if (clash && clash.id !== exceptId) throw conflict('duplicate', `Email ${email} already belongs to another account`);
}

export async function createUser(ctx: Ctx, input: z.output<typeof zUserCreate>): Promise<OrgUser> {
	let passwordHash: string | null = null;
	if (input.password) {
		const problem = validatePasswordStrength(input.password);
		if (problem) throw new OpalError(400, 'weak_password', problem);
		passwordHash = await hashPassword(input.password);
	}
	if (input.email) checkEmailFree(ctx.db, input.email);
	const source = input.username || (input.email ?? '').split('@')[0] || input.name;
	const created = insert(ctx, user, {
		name: input.name,
		username: uniqueUsername(ctx.db, source),
		passwordHash,
		email: input.email ?? null,
		isAdmin: input.isAdmin,
		isActive: true
	});
	return orgUser(ctx.db, created);
}

/** Admins read anyone; others only themselves. */
function visibleUser(ctx: Ctx, id: number) {
	if (!isAdmin(ctx.actor) && selfId(ctx.actor) !== id) throw forbidden('Admin access required');
	return row(ctx.db, id);
}

export function getUser(ctx: Ctx, id: number): OrgUser {
	return orgUser(ctx.db, visibleUser(ctx, id));
}

export function updateUser(ctx: Ctx, input: z.output<typeof zUserUpdate> & { id: number }): OrgUser {
	const target = row(ctx.db, input.id);
	const { id, ...fields } = input;
	const given = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);

	if (!isAdmin(ctx.actor)) {
		if (selfId(ctx.actor) !== id) throw forbidden('Cannot edit other users');
		const allowed = new Set(['name', 'email', 'jobTitle', 'phone', 'workcenterId']);
		const bad = given.filter((k) => !allowed.has(k));
		if (bad.length) throw forbidden(`Cannot change fields: ${bad.join(', ')}`);
	}

	const core: Partial<typeof user.$inferInsert> = {};
	if (fields.name !== undefined) core.name = fields.name;
	if (fields.email !== undefined) {
		core.email = fields.email;
		if (fields.email && fields.email !== target.email) checkEmailFree(ctx.db, fields.email, id);
	}
	if (fields.isActive !== undefined) core.isActive = fields.isActive;
	if (fields.isAdmin !== undefined) core.isAdmin = fields.isAdmin;

	const profile: Parameters<typeof upsertProfile>[2] = {};
	const clean = (v: string | null | undefined) => (v ?? '').trim() || null;
	if (fields.jobTitle !== undefined) profile.jobTitle = clean(fields.jobTitle);
	if (fields.phone !== undefined) profile.phone = clean(fields.phone);
	if (fields.workcenterId !== undefined) {
		if (fields.workcenterId !== null && !ctx.db.select({ id: workcenter.id }).from(workcenter).where(eq(workcenter.id, fields.workcenterId)).get()) {
			throw new OpalError(400, 'unknown_workcenter', `Workcenter ${fields.workcenterId} not found`);
		}
		profile.workcenterId = fields.workcenterId;
	}

	const losesAdmin =
		(fields.isAdmin === false && target.isAdmin) || (fields.isActive === false && target.isAdmin && target.isActive);
	if (losesAdmin && activeAdminCount(ctx.db) <= 1) {
		throw new OpalError(400, 'last_admin', 'Cannot remove the last admin');
	}

	if (Object.keys(core).length) update(ctx, user, id, core);
	if (Object.keys(profile).length) upsertProfile(ctx, id, profile);
	if (fields.isActive === false) revokeAllSessions(ctx.db, id);
	return orgUser(ctx.db, row(ctx.db, id));
}

export function deactivateUser(ctx: Ctx, id: number): void {
	const target = row(ctx.db, id);
	if (!isAdmin(ctx.actor) && selfId(ctx.actor) !== id) throw forbidden('Cannot deactivate other users');
	if (target.isAdmin && target.isActive && activeAdminCount(ctx.db) <= 1) {
		throw new OpalError(400, 'last_admin', 'Cannot deactivate the last admin');
	}
	update(ctx, user, id, { isActive: false });
	revokeAllSessions(ctx.db, id);
}

export function resetPassword(ctx: Ctx, id: number): number {
	const target = row(ctx.db, id);
	if (selfId(ctx.actor) === target.id) {
		throw new OpalError(400, 'self_reset', 'Change your own password instead of resetting it');
	}
	update(ctx, user, id, { passwordHash: null });
	return revokeAllSessions(ctx.db, id);
}

/**
 * Replace the roles a user holds with exactly `roleIds`. The Admin role is not a grant: its id
 * in the list sets isAdmin, its absence clears it.
 */
export function setUserRoles(ctx: Ctx, id: number, roleIds: number[]): OrgUser {
	ensureSystemRoles(ctx.db);
	const target = row(ctx.db, id);
	const wanted = new Set(roleIds);
	const live = ctx.db.select().from(role).all().filter((r) => wanted.has(r.id));
	const missing = [...wanted].filter((w) => !live.some((r) => r.id === w));
	if (missing.length) throw new OpalError(400, 'unknown_role', `Unknown role id(s): ${missing.sort((a, b) => a - b).join(', ')}`);
	const adminIds = new Set(live.filter((r) => r.key === ADMIN_KEY).map((r) => r.id));
	const wantAdmin = adminIds.size > 0;
	for (const a of adminIds) wanted.delete(a);
	if (target.isAdmin && !wantAdmin && target.isActive && activeAdminCount(ctx.db) <= 1) {
		throw new OpalError(400, 'last_admin', 'Cannot remove the last admin');
	}
	if (target.isAdmin !== wantAdmin) update(ctx, user, id, { isAdmin: wantAdmin });
	const grants = ctx.db.select().from(userRole).where(eq(userRole.userId, id)).all();
	const held = new Set(grants.map((g) => g.roleId));
	for (const g of grants) if (!wanted.has(g.roleId)) remove(ctx, userRole, g.id);
	const grantedById = selfId(ctx.actor);
	const grantedAt = new Date().toISOString();
	for (const roleId of [...wanted].sort((a, b) => a - b)) {
		if (!held.has(roleId)) insert(ctx, userRole, { userId: id, roleId, grantedById, grantedAt });
	}
	return orgUser(ctx.db, row(ctx.db, id));
}

// ---------------------------------------------------------------- activity

const SUBJECT_KEYS = [
	'internalPn', 'opalNumber', 'reqNumber', 'riskNumber', 'issueNumber', 'poNumber', 'workOrderNumber',
	'name', 'title', 'label'
];

function subjectOf(values: unknown): string | null {
	if (!values || typeof values !== 'object') return null;
	const v = values as Record<string, unknown>;
	for (const k of SUBJECT_KEYS) if (v[k]) return String(v[k]);
	return null;
}

function tableByName(name: string) {
	for (const t of Object.values(schema)) {
		try {
			if (t && typeof t === 'object' && getTableName(t as never) === name) return t as never as { id: never } & Record<string, never>;
		} catch {
			/* not a table */
		}
	}
	return undefined;
}

/** Human identifier of an audited record: from the change itself, else the live row. */
function subjectFor(db: Db, entity: string, entityId: number, values: unknown): string | null {
	const direct = subjectOf(values);
	if (direct) return direct;
	const t = tableByName(entity);
	if (!t || !('id' in t)) return null;
	const live = db.select().from(t as never).where(eq((t as { id: never }).id, entityId as never)).get();
	return subjectOf(live);
}

export function activity(ctx: Ctx, id: number, limit: number) {
	visibleUser(ctx, id);
	return ctx.db
		.select()
		.from(auditLog)
		.where(eq(auditLog.actorUserId, id))
		.orderBy(desc(auditLog.at), desc(auditLog.id))
		.limit(limit)
		.all()
		.map((r) => ({
			timestamp: r.at,
			table: r.entity,
			action: r.action,
			subject: subjectFor(ctx.db, r.entity, r.entityId, r.after ?? r.before)
		}));
}

// ---------------------------------------------------------------- avatar, profile state

function selfOrAdmin(ctx: Ctx, id: number) {
	if (!isAdmin(ctx.actor) && selfId(ctx.actor) !== id) throw forbidden("Cannot change another user's avatar");
	return row(ctx.db, id);
}

export async function uploadAvatar(ctx: Ctx, id: number, dataBase64: string): Promise<OrgUser> {
	const target = selfOrAdmin(ctx, id);
	await setAvatar(ctx, id, decodeBase64(dataBase64), 'upload');
	return orgUser(ctx.db, target);
}

export async function deleteAvatar(ctx: Ctx, id: number): Promise<OrgUser> {
	const target = selfOrAdmin(ctx, id);
	await removeAvatar(ctx, id);
	return orgUser(ctx.db, target);
}

function me(ctx: Ctx): number {
	const id = selfId(ctx.actor);
	if (id === null) throw forbidden('A signed-in person is needed');
	return id;
}

export const myProfileState = (ctx: Ctx) => profileState(ctx.db, me(ctx));

export function setTimeDisplay(ctx: Ctx, timeDisplay: 'local' | 'utc') {
	upsertProfile(ctx, me(ctx), { timeDisplay });
	return { timeDisplay };
}

export function setupProfile(ctx: Ctx, name: string): OrgUser {
	const id = me(ctx);
	const target = row(ctx.db, id);
	if (target.name !== name) update(ctx, user, id, { name });
	if (getProfile(ctx.db, id)?.needsProfileSetup ?? false) upsertProfile(ctx, id, { needsProfileSetup: false });
	return orgUser(ctx.db, row(ctx.db, id));
}

export { rolesByUser };
