/**
 * Gate checks. Admins and the system hold every gate except none: `admin` itself is held by
 * admins only. Any other gate is held by a user with a role that an admin mapped to it.
 */
import type { Gate } from '@opal/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Actor } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { role, roleGate, userRole } from '../../db/schema/index.ts';

/** Label and description of each gate a role can pass. `admin` is not mappable. */
export const GATE_INFO: Record<string, { label: string; description: string; defaultRoles: string[] }> = {
	'issue.disposition': {
		label: 'Disposition issue tickets',
		description: 'Sign the disposition of a containment-bearing issue.',
		defaultRoles: ['engineer']
	},
	'issue.approve': {
		label: 'Approve resolutions',
		description: 'Sign off an issue in review to Done, or close an issue.',
		defaultRoles: ['quality']
	},
	'execution.skipRequired': {
		label: 'Skip steps with required data',
		description: 'Mark a step not applicable when it has required data fields or a sign-off slot that names a role.',
		defaultRoles: ['engineer', 'quality']
	}
};

export function userHoldsGate(db: Db, userId: number, gate: string): boolean {
	return (
		db
			.select({ id: userRole.id })
			.from(userRole)
			.innerJoin(roleGate, eq(roleGate.roleId, userRole.roleId))
			.where(and(eq(userRole.userId, userId), eq(roleGate.gate, gate)))
			.get() !== undefined
	);
}

export function holdsGate(db: Db, actor: Actor, gate: Gate): boolean {
	if (actor.kind === 'system') return true;
	if (actor.kind === 'anonymous') return false;
	if (actor.isAdmin) return true;
	if (gate === 'admin') return false;
	return userHoldsGate(db, actor.userId, gate);
}

/** Ids of the roles mapped to a gate. */
export function gateRoleIds(db: Db, gate: string): number[] {
	return db
		.select({ id: roleGate.roleId })
		.from(roleGate)
		.where(eq(roleGate.gate, gate))
		.orderBy(roleGate.roleId)
		.all()
		.map((r) => r.id);
}

/** `Requires Engineer or Quality`, or `Requires Admin` when no role is mapped. */
export function gateRefusal(db: Db, gate: string): string {
	const ids = gateRoleIds(db, gate);
	const names = ids.length
		? db.select({ name: role.name }).from(role).where(inArray(role.id, ids)).all().map((r) => r.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
		: [];
	return `Requires ${names.length ? names.join(' or ') : 'Admin'}`;
}
