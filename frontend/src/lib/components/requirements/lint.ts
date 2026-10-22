import type { Finding } from './types.js';

export interface LintSegment {
	text: string;
	severity: 'block' | 'warn' | null;
	title: string;
}

/**
 * Split a statement into runs by the findings covering each character. Block
 * severity wins the run's class; the title carries every covering message.
 */
export function lintSegments(text: string, findings: Finding[]): LintSegment[] {
	const spanned = findings.filter((f) => f.span);
	if (!text) return [];
	if (!spanned.length) return [{ text, severity: null, title: '' }];
	const cover: number[][] = Array.from({ length: text.length }, () => []);
	spanned.forEach((f, i) => {
		const [start, end] = f.span!;
		for (let p = Math.max(0, start); p < Math.min(end, text.length); p++) cover[p].push(i);
	});
	const out: LintSegment[] = [];
	let runStart = 0;
	for (let p = 1; p <= text.length; p++) {
		if (p < text.length && cover[p].join() === cover[runStart].join()) continue;
		const idx = cover[runStart];
		if (idx.length) {
			const here = idx.map((i) => spanned[i]);
			out.push({
				text: text.slice(runStart, p),
				severity: here.some((f) => f.severity === 'block_baseline') ? 'block' : 'warn',
				title: here.map((f) => `${f.rule}: ${f.message}`).join('; ')
			});
		} else {
			out.push({ text: text.slice(runStart, p), severity: null, title: '' });
		}
		runStart = p;
	}
	return out;
}

/** Findings that belong to the baseline checklist rather than the statement text. */
export const FIELD_RULES = new Set([
	'rationale_present',
	'tbd_tbr_discipline',
	'verification_method_set',
	'unique_reference'
]);
