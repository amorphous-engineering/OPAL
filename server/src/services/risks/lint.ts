/**
 * Risk scenario linter (NASA/SP-2011-3422 4.2.1.1). Rule metadata is data in lint_rules.yaml;
 * the check logic is here, keyed by rule name. Findings never block a save. `warn` is advisory;
 * `block_accept` findings are what `accept` enforces.
 */
import type { RiskLintFinding, RiskLintSegment } from '@opal/shared';
import { RULES } from './rules.ts';

export const SCENARIO_FIELDS = ['condition', 'departure', 'consequence'] as const;
export type ScenarioField = (typeof SCENARIO_FIELDS)[number];
export type FieldFindings = Record<ScenarioField, RiskLintFinding[]>;

function finding(name: string, message: string, span: [number, number] | null): RiskLintFinding {
	const rule = RULES[name]!;
	return { rule: rule.id, name, severity: rule.severity, message, span };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alnum = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

function termPattern(term: string): RegExp {
	const head = alnum(term[0]) ? '\\b' : '';
	const tail = alnum(term.at(-1)) ? '\\b' : '';
	return new RegExp(head + escapeRe(term) + tail, 'gi');
}

/** One finding per term occurrence, with its span; {term} is filled in. */
function termFindings(name: string, text: string, message: string): RiskLintFinding[] {
	const out: RiskLintFinding[] = [];
	for (const term of RULES[name]!.terms) {
		for (const m of text.matchAll(termPattern(term))) {
			out.push(finding(name, message.replace('{term}', term), [m.index, m.index + m[0].length]));
		}
	}
	return out;
}

// Suffixes welcome: "delay" matches "delays" and "delayed".
const MEASURABLE = new RegExp(
	RULES.measurable_consequence!.terms.map((t) => `\\b${escapeRe(t)}\\w*`).join('|'),
	'i'
);

const RESPONSE_MESSAGE =
	'response language "{term}" - scenarios presume no response; responses live in the disposition';

/** Findings by scenario field; spans index into that field's text. Empty fields give none. */
export function lintScenario(input: {
	condition?: string | null;
	departure?: string | null;
	consequence?: string | null;
}): FieldFindings {
	const out: FieldFindings = { condition: [], departure: [], consequence: [] };
	const { condition, departure, consequence } = input;
	if (condition?.trim()) {
		out.condition = termFindings(
			'condition_is_fact',
			condition,
			'speculation word "{term}" - conditions are present facts; the uncertainty belongs in the departure'
		);
	}
	if (departure?.trim()) {
		out.departure = termFindings('no_response_language', departure, RESPONSE_MESSAGE);
	}
	if (consequence?.trim()) {
		out.consequence = termFindings('no_response_language', consequence, RESPONSE_MESSAGE);
		if (!MEASURABLE.test(consequence) && !/\d/.test(consequence)) {
			// The span covers the whole field: the problem is what the text lacks, and
			// the underline renderer drops findings without a span.
			out.consequence.push(
				finding(
					'measurable_consequence',
					'consequence names nothing measurable (loss, delay, overrun, failure, damage, injury, scrub, or a number) - impact scores this',
					[0, consequence.length]
				)
			);
		}
	}
	return out;
}

/** Messages of block_accept findings, one per distinct message. */
export function acceptLintBlockers(risk: {
	condition: string | null;
	departure: string | null;
	consequence: string | null;
}): string[] {
	const messages = Object.values(lintScenario(risk))
		.flat()
		.filter((f) => f.severity === 'block_accept')
		.map((f) => f.message);
	return [...new Set(messages)];
}

/**
 * Ordered runs covering `text`. Overlapping spans merge per character: block wins the severity
 * of a run, and every covering finding rides along.
 */
export function lintSegments(text: string, findings: RiskLintFinding[]): RiskLintSegment[] {
	if (!text) return [];
	const spanned = findings.filter((f) => f.span !== null);
	if (!spanned.length) return [{ text, severity: null, findings: [] }];
	const marks: number[][] = Array.from({ length: text.length }, () => []);
	spanned.forEach((f, i) => {
		const [start, end] = f.span!;
		for (let p = Math.max(start, 0); p < Math.min(end, text.length); p++) marks[p]!.push(i);
	});
	const key = (p: number) => marks[p]!.join(',');
	const out: RiskLintSegment[] = [];
	let runStart = 0;
	for (let p = 1; p <= text.length; p++) {
		if (p < text.length && key(p) === key(runStart)) continue;
		const covering = marks[runStart]!.map((i) => spanned[i]!);
		out.push({
			text: text.slice(runStart, p),
			severity: covering.length
				? covering.some((f) => f.severity.startsWith('block'))
					? 'block'
					: 'warn'
				: null,
			findings: covering.map((f) => ({ rule: f.rule, message: f.message }))
		});
		runStart = p;
	}
	return out;
}
