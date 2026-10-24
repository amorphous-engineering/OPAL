/**
 * Requirement lint rule metadata (SP-2016-6105 Rev 2 Appendix C, automatable subset).
 * This is the data of legacy `lint_rules.yaml`, unchanged: ids, severities and term lists.
 * The check logic lives in lint.ts, keyed by rule `name`. Embedding the data in a module keeps
 * it inside the compiled binary.
 *
 * severity: warn (advisory) | block_baseline (must clear before a requirement baselines).
 * Nothing ever blocks save.
 */
export interface LintRule {
	id: string;
	name: string;
	description: string;
	severity: 'warn' | 'block_baseline';
	source: string;
	/** banned_ambiguity_terms: block-severity terms. */
	terms?: string[];
	/** banned_ambiguity_terms: advisory terms ("support loads", "robust" when quantified elsewhere). */
	warnTerms?: string[];
	/** quantitative_has_bounds: the word vocabulary for bounds. Symbols and ranges live in the engine. */
	boundPhrases?: string[];
}

export const LINT_RULES: LintRule[] = [
	{
		id: 'LINT-001',
		name: 'shall_form',
		description:
			'Statement contains exactly one "shall"; zero means it is not a requirement, two or more means split it.',
		severity: 'block_baseline',
		source: 'App. C.1, C.4 (one thought per statement)'
	},
	{
		id: 'LINT-002',
		name: 'active_subject',
		description:
			'Statement begins with a concrete subject ("The <product> shall ..."), not an indefinite pronoun (This/These/It/They/There) or a bare "shall".',
		severity: 'warn',
		source: 'App. C.2'
	},
	{
		id: 'LINT-003',
		name: 'banned_ambiguity_terms',
		description: 'Statement contains none of the banned terms (case-insensitive).',
		severity: 'block_baseline',
		source: 'App. C.4 clarity',
		terms: [
			'as appropriate',
			'etc.',
			'and/or',
			'but not limited to',
			'adequate',
			'sufficient',
			'appropriate',
			'user-friendly',
			'maximize',
			'minimize',
			'easy',
			'rapid',
			'state of the art'
		],
		warnTerms: ['support', 'robust']
	},
	{
		id: 'LINT-004',
		name: 'single_thought',
		description:
			'No semicolon-chained requirements; no embedded rationale ("because", "in order to": move to the rationale field). Multiple shall-clauses are caught by shall_form.',
		severity: 'warn',
		source: 'App. C.4 (one subject, one predicate)'
	},
	{
		id: 'LINT-005',
		name: 'quantitative_has_bounds',
		description:
			'Every numeric value carries a tolerance or bound (±, <=, >=, <, >, a bound phrase from the list, or an explicit "X to Y" range). Bare numbers are unverifiable.',
		severity: 'block_baseline',
		source: 'App. C.2 (complete with tolerances)',
		boundPhrases: [
			'within',
			'no more than',
			'no less than',
			'no greater than',
			'no fewer than',
			'not more than',
			'not less than',
			'not greater than',
			'not fewer than',
			'at least',
			'at most',
			'between',
			'under',
			'over',
			'up to',
			'below',
			'above',
			'max',
			'maximum',
			'min',
			'minimum',
			'tolerance',
			'exactly'
		]
	},
	{
		id: 'LINT-006',
		name: 'positive_statement',
		description:
			'Avoid "shall not": restate positively where possible (negative requirements are hard to verify).',
		severity: 'warn',
		source: 'App. C.3'
	},
	{
		id: 'LINT-007',
		name: 'rationale_present',
		description: 'Rationale is non-empty and is not a restatement of the requirement.',
		severity: 'block_baseline',
		source: 'App. C.3 (intelligible rationale incl. assumptions)'
	},
	{
		id: 'LINT-008',
		name: 'tbd_tbr_discipline',
		description:
			'tbd=true blocks baseline outright. tbr=true requires an owner and a due date; an overdue TBR is flagged.',
		severity: 'block_baseline',
		source: 'App. C.3 (minimize TBD; TBR carries owner, plan, date)'
	},
	{
		id: 'LINT-009',
		name: 'no_implementation_language',
		description:
			'Heuristic: flag "by using", "via", "implemented as", "by means of". Requirements state WHAT, not HOW. Advisory only.',
		severity: 'warn',
		source: 'App. C.2 (free of implementation)'
	},
	{
		id: 'LINT-010',
		name: 'no_operations_language',
		description:
			'Heuristic: flag "The operator/user/crew shall"; operational statements belong in the ConOps, personnel tasks in procedures.',
		severity: 'warn',
		source: 'App. C.1 (operations vs requirements)'
	},
	{
		id: 'LINT-011',
		name: 'verification_method_set',
		description: 'verification_method (analysis/inspection/demonstration/test) is set.',
		severity: 'block_baseline',
		source: 'App. C.4 (individually verifiable)'
	},
	{
		id: 'LINT-012',
		name: 'unique_reference',
		description:
			'req_number assigned and unique, never reused (database-enforced; lint surfaces a missing number on drafts and imports).',
		severity: 'block_baseline',
		source: 'App. C.4 (uniquely referenceable)'
	}
];
