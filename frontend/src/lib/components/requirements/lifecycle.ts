import { REQUIREMENT_LIFECYCLE_STATES, REQUIREMENT_VERIFICATION_METHODS } from '@opal/shared';
import type { Tone } from '#lib/components/opal/index.js';
import type { Verification } from './types.js';

export const LIFECYCLE_STATES = REQUIREMENT_LIFECYCLE_STATES;
export const VERIFICATION_METHODS = REQUIREMENT_VERIFICATION_METHODS;

export const LEVELS: { value: number; label: string }[] = [
	{ value: 0, label: 'L0 mission' },
	{ value: 1, label: 'L1 system' },
	{ value: 2, label: 'L2 subsystem' },
	{ value: 3, label: 'L3 component' }
];

export function lifecycleTone(state: string): Tone {
	switch (state) {
		case 'baselined':
			return 'ok';
		case 'preliminary':
			return 'info';
		case 'superseded':
		case 'cancelled':
			return 'muted';
		default:
			return 'default';
	}
}

export function verificationTone(v: Verification): Tone {
	switch (v) {
		case 'verified':
			return 'ok';
		case 'partial':
			return 'warn';
		default:
			return 'muted';
	}
}

export const verificationLabel: Record<Verification, string> = {
	verified: 'VERIFIED',
	partial: 'PARTIAL',
	open: 'OPEN',
	unallocated: 'NO PARTS',
	not_applicable: 'N/A'
};

/** AIDT initial: A I D T. */
export function methodInitial(method: string | null): string {
	return method ? method[0].toUpperCase() : '—';
}
