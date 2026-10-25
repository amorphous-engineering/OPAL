import { describe, expect, test } from 'bun:test';
import { specFromLabel } from './spec-from-label.ts';

describe('specFromLabel', () => {
	test('a "spec" range with a unit becomes a range and the label loses the text', () => {
		expect(specFromLabel('Piston top face depth from tube end (spec 12.125-12.25 in)')).toEqual({
			unit: 'in',
			spec: { kind: 'range', lower: '12.125', upper: '12.25' },
			label: 'Piston top face depth from tube end'
		});
	});

	test('"approx." with one number is a reference spec', () => {
		expect(specFromLabel('Fuel hose union torque (spec approx. 80 ft-lbs)')).toEqual({
			unit: 'ft_lbf',
			spec: { kind: 'reference', nominal: '80' },
			label: 'Fuel hose union torque'
		});
	});

	test('"approx." with two numbers is a range', () => {
		expect(specFromLabel('Clamp torque (spec approx. 100-150 in-lbs)')).toEqual({
			unit: 'in_lbf',
			spec: { kind: 'range', lower: '100', upper: '150' },
			label: 'Clamp torque'
		});
		expect(specFromLabel('Clamp torque (approx. 100-150 in-lbs)')?.spec).toEqual({
			kind: 'range',
			lower: '100',
			upper: '150'
		});
	});

	test('plus-minus gives a symmetric nominal spec', () => {
		expect(specFromLabel('Gap (5 ± 0.5 mm)')).toEqual({
			unit: 'mm',
			spec: { kind: 'nominal', nominal: '5', plus: '0.5', minus: '0.5' },
			label: 'Gap'
		});
	});

	test('min and max with a number give one-sided specs', () => {
		expect(specFromLabel('Edge distance (min 3 mm)')).toEqual({
			unit: 'mm',
			spec: { kind: 'min', lower: '3' },
			label: 'Edge distance'
		});
		expect(specFromLabel('Leak pressure (max 0.5 psi)')).toEqual({
			unit: 'psi',
			spec: { kind: 'max', upper: '0.5' },
			label: 'Leak pressure'
		});
	});

	test('a spec at the end of the label without parentheses is found', () => {
		expect(specFromLabel('Edge distance min 3 mm')).toEqual({
			unit: 'mm',
			spec: { kind: 'min', lower: '3' },
			label: 'Edge distance'
		});
	});

	test('a spec with an unknown unit keeps the spec and gives no unit', () => {
		const r = specFromLabel('Depth (spec 1-2)');
		expect(r?.unit).toBeUndefined();
		expect(r?.spec).toEqual({ kind: 'range', lower: '1', upper: '2' });
	});

	test('a label without a spec gives null', () => {
		expect(specFromLabel('Serial number')).toBeNull();
		expect(specFromLabel('Hold time (min)')).toBeNull();
		expect(specFromLabel('Minimum gap')).toBeNull();
		expect(specFromLabel('Wait 3 min')).toBeNull();
	});

	test('free text with a number range is not a spec', () => {
		expect(specFromLabel('Fitting tightened 1-3 turns past hand tight')).toBeNull();
		expect(specFromLabel('Tightened (1-3 turns past hand tight)')).toBeNull();
	});

	test('a range with the upper limit below the lower limit is refused', () => {
		expect(specFromLabel('Depth (spec 5-2 in)')).toBeNull();
	});
});
