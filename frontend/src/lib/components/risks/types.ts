/** Scales and tones the risks screens share. Wire types come from `@opal/shared`. */
import { riskSeverityFor, type RiskSeverity } from '@opal/shared';
import type { Tone } from '#lib/components/opal/index.js';

export type Severity = RiskSeverity;

export const PROBABILITY = [
	{ value: 1, label: '1 · Rare' },
	{ value: 2, label: '2 · Unlikely' },
	{ value: 3, label: '3 · Possible' },
	{ value: 4, label: '4 · Likely' },
	{ value: 5, label: '5 · Almost certain' }
];

export const IMPACT = [
	{ value: 1, label: '1 · Negligible' },
	{ value: 2, label: '2 · Minor' },
	{ value: 3, label: '3 · Moderate' },
	{ value: 4, label: '4 · Major' },
	{ value: 5, label: '5 · Severe' }
];


export const SEVERITIES: { value: RiskSeverity; label: string }[] = [
	{ value: 'low', label: 'LOW (1–5)' },
	{ value: 'medium', label: 'MEDIUM (6–12)' },
	{ value: 'high', label: 'HIGH (13–25)' }
];

export const severityOf = riskSeverityFor;

export const severityTone: Record<RiskSeverity, Tone> = {
	low: 'ok',
	medium: 'warn',
	high: 'error'
};

/** Disposition colour: only exceptional or settled states carry a tone. */
export function dispositionTone(d: string): Tone {
	if (d === 'realized') return 'error';
	if (d === 'accepted') return 'ok';
	if (d === 'closed') return 'muted';
	return 'default';
}
