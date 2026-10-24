import { describe, expect, test } from 'bun:test';
import { acceptLintBlockers, lintScenario, lintSegments } from '../../src/services/risks/lint.ts';
import { RULES, parseRules } from '../../src/services/risks/rules.ts';

describe('lint rules data', () => {
	test('the YAML file loads three rules with their terms', () => {
		expect(Object.keys(RULES)).toEqual([
			'condition_is_fact',
			'no_response_language',
			'measurable_consequence'
		]);
		expect(RULES.condition_is_fact!.terms).toEqual(['may', 'might', 'could', 'possibly']);
		expect(RULES.condition_is_fact!.severity).toBe('block_accept');
		expect(RULES.measurable_consequence!.description).toContain('Consequence names something');
	});
	test('the reader refuses a file shape it does not know', () => {
		expect(() => parseRules('things:\n  - a')).toThrow();
	});
});

describe('scenario lint', () => {
	test('RL-01 flags speculation words in the condition, with spans', () => {
		const f = lintScenario({ condition: 'The seal may be worn' }).condition;
		expect(f).toHaveLength(1);
		expect(f[0]!.rule).toBe('RL-01');
		expect(f[0]!.span).toEqual([9, 12]);
	});
	test('RL-01 matches whole words only', () => {
		expect(lintScenario({ condition: 'The mayor is here' }).condition).toHaveLength(0);
	});
	test('RL-02 flags response language in departure and consequence', () => {
		const f = lintScenario({
			departure: 'It fails unless mitigated by a second seal',
			consequence: 'Loss of $5k if we find it'
		});
		expect(f.departure.map((x) => x.rule)).toEqual(['RL-02', 'RL-02']);
		expect(f.consequence.some((x) => x.rule === 'RL-02')).toBe(true);
	});
	test('RL-03 fires on an unmeasurable consequence and carries a whole-field span', () => {
		const text = 'The team is unhappy';
		const f = lintScenario({ consequence: text }).consequence;
		expect(f).toHaveLength(1);
		expect(f[0]!.rule).toBe('RL-03');
		expect(f[0]!.span).toEqual([0, text.length]);
	});
	test('RL-03 does not fire with a measurable noun or a suffix of one; a digit also counts', () => {
		expect(lintScenario({ consequence: 'Schedule delays' }).consequence).toHaveLength(0);
		expect(lintScenario({ consequence: 'Two weeks of rework' }).consequence).toHaveLength(1);
		expect(lintScenario({ consequence: 'Loss of data' }).consequence).toHaveLength(0);
		expect(lintScenario({ consequence: '3 weeks' }).consequence).toHaveLength(0);
	});
	test('empty fields produce no findings', () => {
		const f = lintScenario({ condition: '  ', departure: null });
		expect(Object.values(f).flat()).toHaveLength(0);
	});
	test('accept blockers list a repeated term once', () => {
		const blockers = acceptLintBlockers({
			condition: 'It may rain and may snow',
			departure: null,
			consequence: null
		});
		expect(blockers).toHaveLength(1);
	});
	test('only block_accept findings block acceptance', () => {
		const blockers = acceptLintBlockers({
			condition: 'fact',
			departure: 'unless fixed',
			consequence: 'nothing'
		});
		expect(blockers).toHaveLength(0);
	});
	test('segments cover the text and mark flagged runs', () => {
		const text = 'The seal may leak';
		const segs = lintSegments(text, lintScenario({ condition: text }).condition);
		expect(segs.map((s) => s.text).join('')).toBe(text);
		expect(segs.find((s) => s.text === 'may')!.severity).toBe('block');
		expect(segs[0]!.severity).toBeNull();
	});
});
