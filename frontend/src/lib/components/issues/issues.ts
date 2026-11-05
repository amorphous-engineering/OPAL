/** Display helpers for the issues pages. Types and enum lists come from @opal/shared. */
import type { Tone } from '#lib/components/opal/index.js';
import type { TicketState } from '@opal/shared';

export const TICKET_LABEL: Record<TicketState, string> = {
	pending: 'PENDING',
	in_work: 'IN WORK',
	in_review: 'IN REVIEW',
	done: 'DONE'
};

/** An open issue is not an alarm; what it holds is. A state word needs no colour here. */
const TICKET_TONE: Record<TicketState, Tone> = {
	pending: 'default',
	in_work: 'default',
	in_review: 'default',
	done: 'default'
};

export function ticketLabel(state: string): string {
	return TICKET_LABEL[state as TicketState] ?? state.replace(/_/g, ' ').toUpperCase();
}

export function ticketTone(state: string): Tone {
	return TICKET_TONE[state as TicketState] ?? 'default';
}

/** Issue-list STATE filter: the default view is everything not done. */
export const STATE_FILTER_DEFAULT = 'active';
export const ACTIVE_STATES = 'pending,in_work,in_review';

export const TYPE_ABBREV: Record<string, string> = {
	non_conformance: 'NC',
	bug: 'BUG',
	task: 'TASK',
	improvement: 'IMPR'
};

/** Containment scope names. */
export const CONTAINMENT_OPTION: Record<string, string> = {
	advisory: 'ADVISORY',
	step: 'STEP',
	op: 'OP',
	wo: 'WO'
};

export function priorityTone(p: string): Tone {
	if (p === 'critical') return 'error';
	return 'default';
}

export function kb(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return bytes >= 1048576
		? `${(bytes / 1048576).toFixed(1)} MB`
		: `${(bytes / 1024).toFixed(1)} KB`;
}
