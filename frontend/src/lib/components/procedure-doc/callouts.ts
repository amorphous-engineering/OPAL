import type { Callout } from './types.js';

/** A step's callouts; legacy snapshots carry a single `caution` string instead. */
export function calloutsOf(step: {
	callouts?: Callout[] | null;
	caution?: string | null;
}): Callout[] {
	return step.callouts ?? (step.caution ? [{ kind: 'caution', text: step.caution }] : []);
}

/** Most serious first: a person can be hurt, then hardware, then a note. */
export const CALLOUT_ORDER: Callout['kind'][] = ['warning', 'caution', 'info'];

export const CALLOUT_LABEL: Record<Callout['kind'], string> = {
	warning: 'Warning',
	caution: 'Caution',
	info: 'Info'
};

/** Callouts in the order procedures show them, and in author order within each kind. */
export function orderCallouts<T extends { kind: Callout['kind'] }>(list: T[]): T[] {
	return [...list].sort((a, b) => CALLOUT_ORDER.indexOf(a.kind) - CALLOUT_ORDER.indexOf(b.kind));
}
