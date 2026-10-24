import { describe, expect, test } from 'bun:test';
import { LINT_RULES } from '../../src/services/requirements/lint-rules.ts';
import { lintRequirement, lintStatement } from '../../src/services/requirements/lint.ts';
import { redlineSegments } from '../../src/services/requirements/redline.ts';
import { GOOD } from './helpers.ts';

const names = (f: { name: string }[]) => new Set(f.map((x) => x.name));
const by = <T extends { name: string }>(f: T[], name: string) => f.filter((x) => x.name === name);

describe('statement rules', () => {
	test('a clean statement has no text findings', () => {
		expect(lintStatement(GOOD)).toEqual([]);
	});

	test('shall_form blocks a statement with no shall and one with several', () => {
		const none = by(lintStatement('The engine sustains 20 bar.'), 'shall_form');
		expect(none).toHaveLength(1);
		expect(none[0]!.severity).toBe('block_baseline');
		const multi = by(lintStatement('The engine shall start and shall stop.'), 'shall_form');
		expect(multi).toHaveLength(1);
		expect(multi[0]!.message).toContain('2');
	});

	test('active_subject warns on an indefinite pronoun and on a bare shall', () => {
		expect(names(lintStatement('It shall be robust enough.')).has('active_subject')).toBe(true);
		expect(names(lintStatement('shall survive launch loads.')).has('active_subject')).toBe(true);
		expect(names(lintStatement(GOOD)).has('active_subject')).toBe(false);
	});

	test('banned terms block, and the longest phrase wins over its substring', () => {
		const f = by(lintStatement('The GSE shall vent as appropriate.'), 'banned_ambiguity_terms');
		expect(f).toHaveLength(1);
		expect(f[0]!.message).toContain('as appropriate');
		expect(f[0]!.severity).toBe('block_baseline');
	});

	test('support and robust are advisory only', () => {
		const f = by(
			lintStatement('The frame shall support the tank with robust margins.'),
			'banned_ambiguity_terms'
		);
		expect(new Set(f.map((x) => x.severity))).toEqual(new Set(['warn']));
	});

	test('single_thought flags a semicolon chain and an embedded rationale', () => {
		expect(
			names(lintStatement('The tank shall hold LOX; the lines shall drain.')).has('single_thought')
		).toBe(true);
		expect(
			by(lintStatement('The valve shall close in order to stop flow.'), 'single_thought')
		).toHaveLength(1);
	});

	test('a number needs a bound; designators are not quantities', () => {
		const bare = by(lintStatement('The engine shall burn for 8 seconds.'), 'quantitative_has_bounds');
		expect(bare).toHaveLength(1);
		expect(bare[0]!.severity).toBe('block_baseline');
		for (const ok of [
			GOOD,
			'The stage shall mass under 40 kg.',
			'The valve shall close within 50 ms.',
			'The line shall hold at least 60 bar.',
			'The injector shall satisfy the interface in ICD-0007.',
			'The vehicle shall achieve an apogee of not less than 26,000 ft AGL.',
			'The sensor suite shall include no fewer than 3 thermocouples.',
			'The tank shall operate between 10 and 20 bar.',
			'The burn shall last 8 to 12 seconds.',
			'The avionics shall survive at most 12 g axial.'
		]) {
			expect(names(lintStatement(ok)).has('quantitative_has_bounds')).toBe(false);
		}
		for (const bad of ['The engine shall produce 265 lbf.', 'The tank shall hold 12 kg of oxidizer.']) {
			expect(by(lintStatement(bad), 'quantitative_has_bounds')).toHaveLength(1);
		}
	});

	test('shall not, implementation and operations language warn', () => {
		const neg = by(lintStatement('The vent shall not open in flight.'), 'positive_statement');
		expect(neg).toHaveLength(1);
		expect(neg[0]!.severity).toBe('warn');
		expect(
			names(lintStatement('The controller shall close the valve via a solenoid.')).has(
				'no_implementation_language'
			)
		).toBe(true);
		expect(
			names(lintStatement('The operator shall verify tank pressure before fill.')).has(
				'no_operations_language'
			)
		).toBe(true);
	});

	test('spans point at the offending text', () => {
		const slice = (s: string, f?: { span?: [number, number] }) => s.slice(...f!.span!);
		let s = 'The GSE shall vent as appropriate.';
		expect(slice(s, by(lintStatement(s), 'banned_ambiguity_terms')[0])).toBe('as appropriate');
		s = 'The engine shall burn for 8 seconds.';
		expect(slice(s, by(lintStatement(s), 'quantitative_has_bounds')[0])).toBe('8');
		s = 'The vent shall not open in flight.';
		expect(slice(s, by(lintStatement(s), 'positive_statement')[0])).toBe('shall not');
	});

	test('a banned term used twice yields two spanned findings', () => {
		const s = 'The link shall be rapid and rapid again.';
		const f = by(lintStatement(s), 'banned_ambiguity_terms');
		expect(f.map((x) => s.slice(...x.span!))).toEqual(['rapid', 'rapid']);
	});

	test('field-level findings carry no span', () => {
		const f = lintRequirement(GOOD);
		expect(f.every((x) => x.span === undefined && !('span' in x))).toBe(true);
	});
});

describe('requirement rules', () => {
	test('rationale is required and must not restate the statement', () => {
		const missing = by(lintRequirement(GOOD, { verificationMethod: 'test' }), 'rationale_present');
		expect(missing).toHaveLength(1);
		expect(missing[0]!.message).toBe('rationale is required to baseline');
		const restated = by(
			lintRequirement(GOOD, { rationale: GOOD.toUpperCase(), verificationMethod: 'test' }),
			'rationale_present'
		);
		expect(restated).toHaveLength(1);
		expect(restated[0]!.message).toContain('restates');
	});

	test('TBD blocks, a TBR needs owner and due date, an overdue TBR only warns', () => {
		const base = { rationale: 'r', verificationMethod: 'test' };
		expect(
			lintRequirement(GOOD, { ...base, tbd: true }).some(
				(f) => f.message.includes('TBD') && f.severity === 'block_baseline'
			)
		).toBe(true);
		const messages = by(lintRequirement(GOOD, { ...base, tbr: true }), 'tbd_tbr_discipline').map(
			(f) => f.message
		);
		expect(messages).toContain('TBR requires an owner before baselining');
		expect(messages).toContain('TBR requires a closure due date before baselining');
		const overdue = by(
			lintRequirement(GOOD, {
				...base,
				tbr: true,
				tbrOwnerId: 1,
				tbrDue: new Date(Date.now() - 3 * 86_400_000).toISOString()
			}),
			'tbd_tbr_discipline'
		);
		expect(overdue).toHaveLength(1);
		expect(overdue[0]!.severity).toBe('warn');
		expect(overdue[0]!.message).toContain('overdue');
	});

	test('verification method and REQ number are checked', () => {
		expect(names(lintRequirement(GOOD, { rationale: 'r' })).has('verification_method_set')).toBe(true);
		expect(
			names(lintRequirement(GOOD, { rationale: 'r', verificationMethod: 'test', reqNumber: '' })).has(
				'unique_reference'
			)
		).toBe(true);
		expect(
			lintRequirement(GOOD, { rationale: 'r', verificationMethod: 'test', reqNumber: 'REQ-0001' })
		).toEqual([]);
	});
});

describe('rule data', () => {
	test('every rule has a unique id and name, and the engine knows its name', () => {
		expect(new Set(LINT_RULES.map((r) => r.id)).size).toBe(LINT_RULES.length);
		expect(new Set(LINT_RULES.map((r) => r.name)).size).toBe(LINT_RULES.length);
		expect(LINT_RULES.map((r) => r.id)).toEqual(
			Array.from({ length: 12 }, (_, i) => `LINT-${String(i + 1).padStart(3, '0')}`)
		);
	});
});

describe('redline', () => {
	test('a word diff marks only the changed words', () => {
		const seg = redlineSegments(
			'The engine shall sustain 20 bar.',
			'The engine shall sustain 25 bar continuously.'
		);
		const text = (op: string) =>
			seg
				.filter((s) => s.op === op)
				.map((s) => s.text)
				.join('');
		expect(text('delete')).toContain('20');
		expect(text('insert')).toContain('25');
		expect(text('insert')).toContain('continuously');
		expect(text('delete') + text('insert')).not.toContain('engine');
	});

	test('identical text is one equal segment and the text round-trips', () => {
		expect(redlineSegments('a  b', 'a  b')).toEqual([{ op: 'equal', text: 'a  b' }]);
		const seg = redlineSegments('one two three', 'one three four');
		expect(seg.filter((s) => s.op !== 'insert').map((s) => s.text).join('')).toBe('one two three');
		expect(seg.filter((s) => s.op !== 'delete').map((s) => s.text).join('')).toBe('one three four');
	});
});
