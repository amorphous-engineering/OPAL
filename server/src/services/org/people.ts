/** How a person appears in payloads: the one place profile, role and avatar fields are built. */
import type { OrgUser, PersonRef } from '@opal/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import * as schema from '../../db/schema/index.ts';
import { role, user, userProfile, userRole, workcenter } from '../../db/schema/index.ts';
import { adminRoleRow, ensureSystemRoles } from './roles.ts';

type UserRow = typeof user.$inferSelect;
type ProfileRow = typeof userProfile.$inferSelect;

export function avatarUrl(userId: number, p: ProfileRow | undefined): string | null {
	if (!p?.avatarHash || p.avatarSource === 'removed') return null;
	const v = p.avatarUpdatedAt ? Math.floor(Date.parse(p.avatarUpdatedAt) / 1000) : 0;
	return `/api/users/${userId}/avatar?v=${v}`;
}

export function personRef(u: Pick<UserRow, 'id' | 'name'>, p?: ProfileRow): PersonRef {
	return { id: u.id, name: u.name, avatarUrl: avatarUrl(u.id, p) };
}

/** People by id, as refs. Missing ids are absent from the map. */
export function personRefs(db: Db, ids: Iterable<number>): Map<number, PersonRef> {
	const list = [...new Set(ids)];
	const out = new Map<number, PersonRef>();
	if (!list.length) return out;
	const users = db.select().from(user).where(inArray(user.id, list)).all();
	const profiles = new Map(
		db.select().from(userProfile).where(inArray(userProfile.userId, list)).all().map((p) => [p.userId, p])
	);
	for (const u of users) out.set(u.id, personRef(u, profiles.get(u.id)));
	return out;
}

/** `{userId: [{id, name}]}` for held roles by name; the Admin role is derived from isAdmin. */
export function rolesByUser(db: Db, userIds: number[]): Map<number, { id: number; name: string }[]> {
	const out = new Map<number, { id: number; name: string }[]>();
	if (!userIds.length) return out;
	ensureSystemRoles(db);
	const rows = db
		.select({ userId: userRole.userId, id: role.id, name: role.name })
		.from(userRole)
		.innerJoin(role, eq(role.id, userRole.roleId))
		.where(inArray(userRole.userId, userIds))
		.all();
	for (const r of rows) {
		const list = out.get(r.userId) ?? [];
		list.push({ id: r.id, name: r.name });
		out.set(r.userId, list);
	}
	const admin = adminRoleRow(db);
	if (admin) {
		for (const u of db.select({ id: user.id, isAdmin: user.isAdmin }).from(user).where(inArray(user.id, userIds)).all()) {
			if (!u.isAdmin) continue;
			const list = out.get(u.id) ?? [];
			list.push({ id: admin.id, name: admin.name });
			out.set(u.id, list);
		}
	}
	for (const list of out.values()) list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	return out;
}

/** The passkey table belongs to the auth area; read it when it exists. */
function passkeyOwners(db: Db, ids: number[]): Set<number> {
	const t = (schema as Record<string, any>).passkeyCredential;
	if (!t?.userId || !ids.length) return new Set();
	return new Set(db.select({ userId: t.userId }).from(t).where(inArray(t.userId, ids)).all().map((r: { userId: number }) => r.userId));
}

/** Build the full user payload for many users with a fixed number of queries. */
export function orgUsers(db: Db, rows: UserRow[]): OrgUser[] {
	const ids = rows.map((r) => r.id);
	const profiles = new Map(
		ids.length ? db.select().from(userProfile).where(inArray(userProfile.userId, ids)).all().map((p) => [p.userId, p]) : []
	);
	const wcIds = [...new Set([...profiles.values()].map((p) => p.workcenterId).filter((v): v is number => v !== null))];
	const wcs = new Map(
		wcIds.length ? db.select({ id: workcenter.id, name: workcenter.name }).from(workcenter).where(inArray(workcenter.id, wcIds)).all().map((w) => [w.id, w]) : []
	);
	const roles = rolesByUser(db, ids);
	const passkeys = passkeyOwners(db, ids);
	return rows.map((u) => {
		const p = profiles.get(u.id);
		return {
			id: u.id,
			name: u.name,
			username: u.username,
			email: u.email,
			isActive: u.isActive,
			isAdmin: u.isAdmin,
			createdAt: u.createdAt,
			updatedAt: u.updatedAt,
			hasPassword: u.passwordHash !== null,
			hasPasskey: passkeys.has(u.id),
			ssoLinked: u.oidcSubject !== null,
			jobTitle: p?.jobTitle ?? null,
			phone: p?.phone ?? null,
			workcenter: p?.workcenterId != null ? (wcs.get(p.workcenterId) ?? null) : null,
			roles: roles.get(u.id) ?? [],
			avatarUrl: avatarUrl(u.id, p)
		};
	});
}

export function orgUser(db: Db, row: UserRow): OrgUser {
	return orgUsers(db, [row])[0]!;
}
