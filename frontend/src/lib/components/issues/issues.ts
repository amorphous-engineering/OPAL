/** Display helpers for the issues pages. Types and enum lists come from @opal/shared. */
import type { Tone } from '#lib/components/opal/index.js';
import type { TicketState } from '@opal/shared';

export const TICKET_LABEL: Record<TicketState, string> = {
	pending: 'PENDING',
	in_work: 'IN WORK',
	in_review: 'IN REVIEW',
	done: 'DONE'
};

/** Colour is semantic: red = untouched, amber = in flight, green = done. */
const TICKET_TONE: Record<TicketState, Tone> = {
	pending: 'error',
	in_work: 'warn',
	in_review: 'warn',
	done: 'ok'
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

/** Option text for the containment picker: scope, then what it holds. */
export const CONTAINMENT_OPTION: Record<string, string> = {
	advisory: 'ADVISORY — holds nothing',
	step: 'STEP — holds the step',
	op: 'OP — holds the operation',
	wo: 'WO — holds the work order'
};

export function priorityTone(p: string): Tone {
	if (p === 'critical' || p === 'high') return 'error';
	if (p === 'low') return 'muted';
	return 'default';
}

export function kb(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return bytes >= 1048576
		? `${(bytes / 1048576).toFixed(1)} MB`
		: `${(bytes / 1024).toFixed(1)} KB`;
}
