/**
 * Requirement linter: SP-2016-6105 Rev 2 Appendix C, automatable subset.
 *
 * Rule metadata (ids, severities, term lists) is data in lint-rules.ts. The check logic is here,
 * keyed by rule name. `warn` is advisory everywhere. `block_baseline` findings are what
 * baselining enforces. The non-lintable half of Appendix C (needs vs wants, defensible tolerances)
 * is judgment and stays out of code.
 */
import type { RequirementFinding as Finding } from '@opal/shared';
import { LINT_RULES } from './lint-rules.ts';

const RULES = new Map(LINT_RULES.map((r) => [r.name, r]));

type Span = [number, number];

function finding(
	name: string,
	message: string,
	opts: { severity?: Finding['severity']; span?: Span } = {}
): Finding {
	const rule = RULES.get(name)!;
	const f: Finding = { rule: rule.id, name, severity: opts.severity ?? rule.severity, message };
	if (opts.span) f.span = opts.span;
	return f;
}

const SHALL = /\bshall\b/gi;
const INDEFINITE_START = /^\s*(this|these|it|they|there)\b/i;
const BARE_SHALL_START = /^\s*shall\b/i;
const EMBEDDED_RATIONALE = /\bbecause\b|\bin order to\b/i;
const SHALL_NOT = /\bshall\s+not\b/i;
const IMPLEMENTATION = /\bby using\b|\bvia\b|\bimplemented as\b|\bby means of\b/i;
const OPERATIONS_SUBJECT = /^\s*the\s+(operator|user|crew)\b/i;
/** Designator tokens (REQ-0042, ICD-0007, PO/1-001) are references, not quantities. */
const DESIGNATOR = /\b[A-Z]{2,}[-/][\dA-Z/-]*\d\b/g;
const NUMBER = /\d+(?:\.\d+)?/g;
/** Structural bound patterns. The word vocabulary is data (bound_phrases). */
const BOUND_SYMBOLS = '±|\\+/-|<=|>=|≤|≥|<|>';
const BOUND_RANGE = '\\d[\\d,.]*\\s+to\\s+\\d';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

const BOUND_MARKERS = new RegExp(
	[
		BOUND_SYMBOLS,
		BOUND_RANGE,
		...(RULES.get('quantitative_has_bounds')!.boundPhrases ?? []).map((p) => `\\b${escape(p)}\\b`)
	].join('|'),
	'i'
);

const isWord = (c: string) => /[\p{L}\p{N}_]/u.test(c);

/** One finding per banned-term occurrence. Longer phrases shadow their substrings. */
function lintBannedTerms(statement: string): Finding[] {
	const rule = RULES.get('banned_ambiguity_terms')!;
	const blockTerms = rule.terms ?? [];
	const warnTerms = rule.warnTerms ?? [];
	const findings: Finding[] = [];
	const covered: Span[] = [];
	for (const term of [...blockTerms, ...warnTerms].sort((a, b) => b.length - a.length)) {
		// \b only works against word characters: "etc." and "and/or" end without one.
		const head = isWord(term[0]!) ? '\\b' : '';
		const tail = isWord(term[term.length - 1]!) ? '\\b' : '';
		const spans: Span[] = [];
		for (const m of statement.matchAll(new RegExp(head + escape(term) + tail, 'gi'))) {
			const span: Span = [m.index, m.index + m[0].length];
			if (!covered.some(([s, e]) => span[0] >= s && span[1] <= e)) spans.push(span);
		}
		if (!spans.length) continue;
		covered.push(...spans);
		const severity = warnTerms.includes(term) ? 'warn' : undefined;
		for (const span of spans) {
			findings.push(
				finding('banned_ambiguity_terms', `ambiguous term "${term}": replace with a verifiable formulation`, {
					severity,
					span
				})
			);
		}
	}
	return findings;
}

/** Span of the first number outside a designator, or null. */
function unboundedNumberSpan(statement: string): Span | null {
	const designators = [...statement.matchAll(DESIGNATOR)].map((m): Span => [m.index, m.index + m[0].length]);
	for (const m of statement.matchAll(NUMBER)) {
		const start = m.index;
		const end = start + m[0].length;
		if (!designators.some(([s, e]) => s <= start && end <= e)) return [start, end];
	}
	return null;
}

/** Text-only rules over the shall statement. */
export function lintStatement(statement: string): Finding[] {
	const findings: Finding[] = [];
	const shalls = [...statement.matchAll(SHALL)];
	if (!shalls.length) {
		findings.push(finding('shall_form', 'statement contains no "shall": not a verifiable requirement'));
	} else if (shalls.length > 1) {
		const second = shalls[1]!;
		findings.push(
			finding(
				'shall_form',
				`statement contains ${shalls.length} "shall" clauses: split into separate requirements`,
				{ span: [second.index, second.index + second[0].length] }
			)
		);
	}

	let m: RegExpMatchArray | null;
	if ((m = statement.match(INDEFINITE_START))) {
		findings.push(
			finding(
				'active_subject',
				'statement starts with an indefinite pronoun: name the product ("The <product> shall ...")',
				{ span: [m.index!, m.index! + m[0].length] }
			)
		);
	} else if ((m = statement.match(BARE_SHALL_START))) {
		findings.push(
			finding('active_subject', 'statement has no subject before "shall"', {
				span: [m.index!, m.index! + m[0].length]
			})
		);
	}

	findings.push(...lintBannedTerms(statement));

	const semi = statement.indexOf(';');
	if (semi !== -1) {
		findings.push(
			finding('single_thought', 'semicolon-chained statement: split into one requirement per thought', {
				span: [semi, semi + 1]
			})
		);
	}
	if ((m = statement.match(EMBEDDED_RATIONALE))) {
		findings.push(
			finding(
				'single_thought',
				'embedded rationale ("because" / "in order to"): move it to the rationale field',
				{ span: [m.index!, m.index! + m[0].length] }
			)
		);
	}

	const number = unboundedNumberSpan(statement);
	if (number && !BOUND_MARKERS.test(statement)) {
		findings.push(
			finding(
				'quantitative_has_bounds',
				'numeric value without a tolerance or bound (±, <=, within, ...) is unverifiable',
				{ span: number }
			)
		);
	}

	if ((m = statement.match(SHALL_NOT))) {
		findings.push(
			finding('positive_statement', '"shall not" is hard to verify: restate positively where possible', {
				span: [m.index!, m.index! + m[0].length]
			})
		);
	}
	if ((m = statement.match(IMPLEMENTATION))) {
		findings.push(
			finding(
				'no_implementation_language',
				'implementation language: state WHAT is required, not HOW it is achieved',
				{ span: [m.index!, m.index! + m[0].length] }
			)
		);
	}
	if ((m = statement.match(OPERATIONS_SUBJECT))) {
		findings.push(
			finding(
				'no_operations_language',
				'operations language: operator/user tasks belong in the ConOps or a procedure',
				{ span: [m.index!, m.index! + m[0].length] }
			)
		);
	}
	return findings;
}

const normalize = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface LintFields {
	rationale?: string | null;
	verificationMethod?: string | null;
	tbd?: boolean;
	tbr?: boolean;
	tbrOwnerId?: number | null;
	tbrDue?: string | null;
	reqNumber?: string | null;
}

/**
 * Full requirement lint: the statement plus the baseline-readiness fields. The messages for
 * rationale, TBD and TBR are what the baseline operation reports to its caller.
 */
export function lintRequirement(statement: string, f: LintFields = {}): Finding[] {
	const findings = lintStatement(statement);

	if (!(f.rationale ?? '').trim()) {
		findings.push(finding('rationale_present', 'rationale is required to baseline'));
	} else if (normalize(f.rationale!) === normalize(statement)) {
		findings.push(
			finding(
				'rationale_present',
				'rationale restates the requirement: record why it exists, not what it says'
			)
		);
	}

	if (f.tbd) {
		findings.push(
			finding('tbd_tbr_discipline', 'statement contains a TBD value; resolve it before baselining')
		);
	}
	if (f.tbr) {
		if (!f.tbrOwnerId) {
			findings.push(finding('tbd_tbr_discipline', 'TBR requires an owner before baselining'));
		}
		if (!f.tbrDue) {
			findings.push(finding('tbd_tbr_discipline', 'TBR requires a closure due date before baselining'));
		} else if (new Date(f.tbrDue).getTime() < Date.now()) {
			findings.push(
				finding(
					'tbd_tbr_discipline',
					`TBR closure date ${new Date(f.tbrDue).toISOString().slice(0, 10)} is overdue`,
					{ severity: 'warn' }
				)
			);
		}
	}

	if (!(f.verificationMethod ?? '').trim()) {
		findings.push(
			finding(
				'verification_method_set',
				'verification method (analysis/inspection/demonstration/test) is not set'
			)
		);
	}

	if (f.reqNumber != null && !f.reqNumber.trim()) {
		findings.push(finding('unique_reference', 'requirement has no REQ number assigned'));
	}
	return findings;
}

/** Lint a stored requirement row. */
export function lintRow(r: {
	statement: string;
	rationale: string | null;
	verificationMethod: string | null;
	tbd: boolean;
	tbr: boolean;
	tbrOwnerId: number | null;
	tbrDue: string | null;
	reqNumber: string;
}): Finding[] {
	return lintRequirement(r.statement, r);
}

/** Messages of the block_baseline findings, without repeats (a term used twice is one blocker). */
export function baselineLintBlockers(r: Parameters<typeof lintRow>[0]): string[] {
	const messages = lintRow(r)
		.filter((f) => f.severity === 'block_baseline')
		.map((f) => f.message);
	return [...new Set(messages)];
}
