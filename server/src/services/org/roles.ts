/**
 * Roles (qualifications) and the gates they pass.
 *
 * Four system roles exist on every install: Engineer, Technician, Quality, Admin. The Admin
 * role is not stored as a grant: its membership IS user.isAdmin. A sign-off slot that names a
 * role can be signed only by a holder, or by an admin.
 */
import { OpalError, conflict, notFound, now } from '@opal/shared';
import type { GateInfo, Role } from '@opal/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { role, roleGate, user, userRole } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { GATE_INFO, gateRoleIds } from './gates.ts';
import { personRefs } from './people.ts';

export const ADMIN_KEY = 'admin';

/** key -> [name, description, default gates]. Order is display order. */
export const SYSTEM_ROLES: Record<string, [string, string, string[]]> = {
	engineer: ['Engineer', 'Dispositions issue tickets and verifies engineering-critical steps.', ['issue.disposition']],
	technician: ['Technician', 'Performs build and assembly steps.', []],
	quality: ['Quality', 'Approves issue resolutions and buys off quality-critical steps.', ['issue.approve']],
	admin: ['Admin', 'Administers the application and passes every gate.', []]
};

const seeded = new WeakSet<Db>();

/**
 * Create the system roles that are missing. Default gate mappings are added only when a role
 * is created here, never again, so an admin's edits stick. Not audited: this is install setup,
 * not a person's change. Cheap after the first call per database.
 */
export function ensureSystemRoles(db: Db): void {
	if (seeded.has(db)) return;
	const ts = now();
	for (const [key, [name, description, gates]] of Object.entries(SYSTEM_ROLES)) {
		if (db.select({ id: role.id }).from(role).where(eq(role.key, key)).get()) continue;
		// A custom role with the same name becomes the system role in place.
		let row = db.select().from(role).where(sql`lower(${role.name}) = ${name.toLowerCase()}`).get();
		if (row) {
			db.update(role)
				.set({ key, isSystem: true, name, description: row.description?.trim() ? row.description : description, updatedAt: ts })
				.where(eq(role.id, row.id))
				.run();
		} else {
			row = db.insert(role).values({ name, description, key, isSystem: true, createdAt: ts, updatedAt: ts }).returning().get();
		}
		for (const gate of gates) db.insert(roleGate).values({ roleId: row.id, gate }).onConflictDoNothing().run();
	}
	seeded.add(db);
}

export function adminRoleRow(db: Db) {
	ensureSystemRoles(db);
	return db.select().from(role).where(eq(role.key, ADMIN_KEY)).get();
}

export function findRole(db: Db, name: string | null | undefined) {
	const cleaned = (name ?? '').trim();
	if (!cleaned) return undefined;
	return db.select().from(role).where(sql`lower(${role.name}) = ${cleaned.toLowerCase()}`).get();
}

/** Lower-cased names of the roles a user holds; `admin` for admins. Slot checks use this. */
export function roleNamesOf(db: Db, userId: number): Set<string> {
	ensureSystemRoles(db);
	const names = new Set(
		db
			.select({ name: role.name })
			.from(userRole)
			.innerJoin(role, eq(role.id, userRole.roleId))
			.where(eq(userRole.userId, userId))
			.all()
			.map((r) => r.name.toLowerCase())
	);
	if (db.select({ id: user.id }).from(user).where(and(eq(user.id, userId), eq(user.isAdmin, true))).get()) {
		names.add(ADMIN_KEY);
	}
	return names;
}

/** True when a slot names no role, or the holder set contains it. Admins hold every role. */
export function holdsSlotRole(holder: Set<string>, slotRole: string | null | undefined): boolean {
	if (!(slotRole ?? '').trim()) return true;
	return holder.has(ADMIN_KEY) || holder.has(slotRole!.trim().toLowerCase());
}

/** The canonical name of a known role; null for a blank name; throws 422 for an unknown one. */
export function canonicalRoleName(db: Db, name: string | null | undefined): string | null {
	const cleaned = (name ?? '').trim();
	if (!cleaned) return null;
	const r = findRole(db, cleaned);
	if (!r) throw new OpalError(422, 'unknown_role', `Unknown role '${cleaned}'`);
	return r.name;
}

function memberCounts(db: Db): Map<number, number> {
	const rows = db
		.select({ roleId: userRole.roleId, n: sql<number>`count(*)` })
		.from(userRole)
		.innerJoin(user, eq(user.id, userRole.userId))
		.where(eq(user.isActive, true))
		.groupBy(userRole.roleId)
		.all();
	const counts = new Map(rows.map((r) => [r.roleId, r.n]));
	const admins = db.select({ n: sql<number>`count(*)` }).from(user).where(and(eq(user.isAdmin, true), eq(user.isActive, true))).get()!.n;
	const admin = db.select({ id: role.id }).from(role).where(eq(role.key, ADMIN_KEY)).get();
	if (admin) counts.set(admin.id, admins);
	return counts;
}

type RoleRow = typeof role.$inferSelect;
function toRole(r: RoleRow, counts: Map<number, number>): Role {
	return {
		id: r.id,
		name: r.name,
		description: r.description,
		key: r.key,
		isSystem: r.isSystem,
		memberCount: counts.get(r.id) ?? 0,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

export function listRoles(ctx: Pick<Ctx, 'db'>): Role[] {
	ensureSystemRoles(ctx.db);
	const counts = memberCounts(ctx.db);
	const keys = Object.keys(SYSTEM_ROLES);
	return ctx.db
		.select()
		.from(role)
		.all()
		.sort((a, b) => {
			const ka = a.key ? keys.indexOf(a.key) : -1;
			const kb = b.key ? keys.indexOf(b.key) : -1;
			if (ka >= 0 && kb >= 0) return ka - kb;
			if (ka >= 0) return -1;
			if (kb >= 0) return 1;
			return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
		})
		.map((r) => toRole(r, counts));
}

function getRow(db: Db, id: number): RoleRow {
	ensureSystemRoles(db);
	const r = db.select().from(role).where(eq(role.id, id)).get();
	if (!r) throw notFound('Role');
	return r;
}

export function getRole(ctx: Pick<Ctx, 'db'>, id: number) {
	const r = getRow(ctx.db, id);
	const q = ctx.db.select({ id: user.id }).from(user);
	const memberIds =
		r.key === ADMIN_KEY
			? q.where(and(eq(user.isAdmin, true), eq(user.isActive, true))).orderBy(user.name).all()
			: ctx.db
					.select({ id: user.id })
					.from(user)
					.innerJoin(userRole, eq(userRole.userId, user.id))
					.where(and(eq(userRole.roleId, r.id), eq(user.isActive, true)))
					.orderBy(user.name)
					.all();
	const refs = personRefs(ctx.db, memberIds.map((m) => m.id));
	const members = memberIds.map((m) => refs.get(m.id)!).filter(Boolean);
	return { ...toRole(r, new Map([[r.id, members.length]])), members };
}

export function createRole(ctx: Ctx, input: { name: string; description?: string | null }): Role {
	ensureSystemRoles(ctx.db);
	const existing = findRole(ctx.db, input.name);
	if (existing) throw conflict('duplicate', `Role '${existing.name}' already exists`);
	const row = insert(ctx, role, { name: input.name, description: input.description ?? null, key: null, isSystem: false });
	return toRole(row, new Map());
}

export function updateRole(ctx: Ctx, input: { id: number; name?: string; description?: string | null }): Role {
	const r = getRow(ctx.db, input.id);
	if (r.isSystem && input.name !== undefined && input.name !== r.name) {
		throw new OpalError(400, 'system_role', `${r.name} is a system role; it cannot be renamed`);
	}
	if (input.name !== undefined) {
		const clash = findRole(ctx.db, input.name);
		if (clash && clash.id !== r.id) throw conflict('duplicate', `Role '${clash.name}' already exists`);
	}
	const patch: Partial<typeof role.$inferInsert> = {};
	if (input.name !== undefined) patch.name = input.name;
	if (input.description !== undefined) patch.description = input.description;
	return toRole(update(ctx, role, r.id, patch), memberCounts(ctx.db));
}

export function deleteRole(ctx: Ctx, id: number): void {
	const r = getRow(ctx.db, id);
	if (r.isSystem) throw new OpalError(400, 'system_role', `${r.name} is a system role; it cannot be deleted`);
	for (const g of ctx.db.select().from(userRole).where(eq(userRole.roleId, id)).all()) remove(ctx, userRole, g.id);
	for (const g of ctx.db.select().from(roleGate).where(eq(roleGate.roleId, id)).all()) remove(ctx, roleGate, g.id);
	remove(ctx, role, id);
}

// ---------------------------------------------------------------- gates

function gateInfo(db: Db, key: string): GateInfo {
	const info = GATE_INFO[key]!;
	return { key, label: info.label, description: info.description, roleIds: gateRoleIds(db, key) };
}

export function listGates(ctx: Pick<Ctx, 'db'>): GateInfo[] {
	ensureSystemRoles(ctx.db);
	return Object.keys(GATE_INFO).map((k) => gateInfo(ctx.db, k));
}

export function setGate(ctx: Ctx, key: string, roleIds: number[]): GateInfo {
	ensureSystemRoles(ctx.db);
	if (!GATE_INFO[key]) throw notFound(`Gate '${key}'`);
	const wanted = new Set(roleIds);
	const live = new Set(
		wanted.size ? ctx.db.select({ id: role.id }).from(role).where(inArray(role.id, [...wanted])).all().map((r) => r.id) : []
	);
	const missing = [...wanted].filter((id) => !live.has(id));
	if (missing.length) {
		throw new OpalError(400, 'unknown_role', `Unknown role id(s): ${missing.sort((a, b) => a - b).join(', ')}`);
	}
	const rows = ctx.db.select().from(roleGate).where(eq(roleGate.gate, key)).all();
	const held = new Set(rows.map((r) => r.roleId));
	for (const r of rows) if (!wanted.has(r.roleId)) remove(ctx, roleGate, r.id);
	for (const id of [...wanted].sort((a, b) => a - b)) if (!held.has(id)) insert(ctx, roleGate, { roleId: id, gate: key });
	return gateInfo(ctx.db, key);
}
