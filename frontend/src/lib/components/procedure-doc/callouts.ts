import type { Callout } from './types.js';

/** A step's callouts; legacy snapshots carry a single `caution` string instead. */
export function calloutsOf(step: {
	callouts?: Callout[] | null;
	caution?: string | null;
}): Callout[] {
	return step.callouts ?? (step.caution ? [{ kind: 'caution', text: step.caution }] : []);
}
