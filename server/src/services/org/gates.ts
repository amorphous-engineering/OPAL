/** Gate checks. Admins and the system hold every gate. */
import type { Gate } from '@opal/shared';
import type { Actor } from '../../context.ts';
import type { Db } from '../../db/client.ts';

export function holdsGate(_db: Db, actor: Actor, gate: Gate): boolean {
	if (actor.kind === 'system') return true;
	if (actor.kind === 'anonymous') return false;
	if (actor.isAdmin) return true;
	if (gate === 'admin') return false;
	// Role-granted gates arrive with the roles port (org area).
	return false;
}
