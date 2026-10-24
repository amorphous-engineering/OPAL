/**
 * Sign-off slots of a step. A step stores the roles in slot order (or null for the default).
 * The effective list gets its labels from the position: Primary buyoff first, Secondary buyoff
 * after. `requiresSignoff` and `requiredRole` are derived from the effective list, never stored.
 */
import {
	PRIMARY_SIGNOFF_LABEL,
	SECONDARY_SIGNOFF_LABEL,
	type ProcedureSignoff
} from '@opal/shared';
import type { Db } from '../../db/client.ts';
import { canonicalRoleName, ensureSystemRoles } from '../org/roles.ts';

export type StoredSignoffs = { role: string | null }[] | null;

export const slotLabel = (i: number) => (i === 0 ? PRIMARY_SIGNOFF_LABEL : SECONDARY_SIGNOFF_LABEL);

/** Labels by position, for reads and comparisons. */
export function relabel(slots: { role?: string | null }[]): ProcedureSignoff[] {
	return slots.map((s, i) => ({ label: slotLabel(i), role: s.role?.trim() || null }));
}

/** The slots a step has when none is stored. */
export function defaultSlots(hasChildren: boolean): ProcedureSignoff[] {
	return hasChildren ? [] : relabel([{ role: null }]);
}

/**
 * A step's slots in order. A stored empty list on a leaf reads as the default Primary slot:
 * a leaf always has at least one. An OP with sub-steps may have none.
 */
export function effectiveSignoffs(stored: StoredSignoffs, hasChildren: boolean): ProcedureSignoff[] {
	if (stored === null || stored === undefined) return defaultSlots(hasChildren);
	if (stored.length === 0 && !hasChildren) return defaultSlots(false);
	return relabel(stored);
}

/** (requiresSignoff, requiredRole) implied by an effective list. */
export function deriveFlags(slots: ProcedureSignoff[], hasChildren: boolean) {
	return {
		requiresSignoff: hasChildren ? slots.length > 0 : slots.length > 1,
		requiredRole: slots[0]?.role ?? null
	};
}

export interface SignoffWrite {
	signoffs?: { label?: string; role?: string | null }[] | null;
	requiresSignoff?: boolean;
	requiredRole?: string | null;
}

/**
 * The stored value after an author's write; `undefined` when the write touches nothing.
 * An explicit `signoffs` list wins. `requiresSignoff` and `requiredRole` are carried into the
 * effective list: turning sign-off on adds the trailing slot, turning it off drops every slot
 * after the first (all of them for an OP), a role lands on slot 0. Every role must exist.
 */
export function writeSignoffs(
	db: Db,
	current: StoredSignoffs,
	hasChildren: boolean,
	input: SignoffWrite
): StoredSignoffs | undefined {
	ensureSystemRoles(db);
	if (input.signoffs !== undefined) {
		if (input.signoffs === null) return null;
		return input.signoffs.map((s) => ({ role: canonicalRoleName(db, s.role) }));
	}
	if (input.requiresSignoff === undefined && input.requiredRole === undefined) return undefined;
	let slots = effectiveSignoffs(current, hasChildren).map((s) => ({ role: s.role }));
	if (input.requiresSignoff !== undefined) {
		if (hasChildren) {
			if (input.requiresSignoff && slots.length === 0) slots = [{ role: null }];
			else if (!input.requiresSignoff) slots = [];
		} else if (input.requiresSignoff && slots.length < 2) {
			slots = [...slots, { role: null }];
		} else if (!input.requiresSignoff) {
			slots = slots.slice(0, 1);
		}
	}
	if (input.requiredRole !== undefined && slots.length > 0) {
		slots[0] = { role: canonicalRoleName(db, input.requiredRole) };
	}
	return slots;
}
