import { describe, expect, test } from 'bun:test';
import { specLimits, specResult, specText, zSpec, type Spec } from './specs.ts';
import { UNITS, UNIT_DIMENSIONS, convert, unitByCode, unitFromText, unitSymbol } from './units.ts';

describe('units', () => {
	test('every unit has a unique code, a known dimension and a positive factor', () => {
		expect(new Set(UNITS.map((u) => u.code)).size).toBe(UNITS.length);
		for (const u of UNITS) {
			expect(UNIT_DIMENSIONS).toContain(u.dimension);
			expect(u.factor).toBeGreaterThan(0);
		}
	});

	test('conversions match known values and round-trip', () => {
		expect(convert(1, 'in', 'mm')).toBeCloseTo(25.4, 9);
		expect(convert(80, 'ft_lbf', 'n_m')).toBeCloseTo(108.4655, 3);
		expect(convert(12, 'in_lbf', 'ft_lbf')).toBeCloseTo(1, 9);
		expect(convert(1, 'bar', 'psi')).toBeCloseTo(14.50377, 4);
		expect(convert(212, 'degf', 'degc')).toBeCloseTo(100, 9);
		expect(convert(-40, 'degc', 'degf')).toBeCloseTo(-40, 9);
		for (const u of UNITS) {
			const peer = UNITS.find((x) => x.dimension === u.dimension && x.code !== u.code) ?? u;
			expect(convert(convert(3.25, u.code, peer.code), peer.code, u.code)).toBeCloseTo(3.25, 9);
		}
	});

	test('a value never converts across dimensions', () => {
		expect(() => convert(1, 'in', 'n_m')).toThrow();
		expect(() => convert(1, 'nope', 'in')).toThrow();
	});

	test('free text from labels maps to a unit code', () => {
		expect(unitFromText('in-lbs')).toBe('in_lbf');
		expect(unitFromText('ft lbs')).toBe('ft_lbf');
		expect(unitFromText('in.')).toBe('in');
		expect(unitFromText('PSI')).toBe('psi');
		expect(unitFromText('°F')).toBe('degf');
		expect(unitFromText('N·m')).toBe('n_m');
		expect(unitFromText('bananas')).toBeUndefined();
	});

	test('a stored unit shows its symbol, and old free text shows as is', () => {
		expect(unitSymbol('in_lbf')).toBe('in·lbf');
		expect(unitByCode('um')?.symbol).toBe('µm');
		expect(unitSymbol('widgets')).toBe('widgets');
		expect(unitSymbol(null)).toBe('');
	});
});

describe('specs', () => {
	const range: Spec = { kind: 'range', lower: '12.125', upper: '12.25' };

	test('a value on a limit is in spec, and just outside is out of spec', () => {
		expect(specResult(range, 12.125)).toBe('in_spec');
		expect(specResult(range, '12.250')).toBe('in_spec');
		expect(specResult(range, '12.1249')).toBe('out_of_spec');
		expect(specResult(range, 12.2501)).toBe('out_of_spec');
	});

	test('limits compare exactly, without float drift', () => {
		const tight: Spec = { kind: 'max', upper: '0.3' };
		expect(specResult(tight, 0.1 + 0.2)).toBe('out_of_spec'); // 0.30000000000000004
		expect(specResult(tight, '0.3')).toBe('in_spec');
		expect(specResult({ kind: 'min', lower: '0.00001' }, '0.000009')).toBe('out_of_spec');
	});

	test('nominal with plus and minus tolerances', () => {
		const s: Spec = { kind: 'nominal', nominal: '100', plus: '5', minus: '2.5' };
		expect(specLimits(s)).toEqual({ lower: '97.5', upper: '105' });
		expect(specResult(s, 97.5)).toBe('in_spec');
		expect(specResult(s, 97.4)).toBe('out_of_spec');
		expect(specResult(s, 105.01)).toBe('out_of_spec');
		expect(specLimits({ kind: 'nominal', nominal: '0.5', plus: '0.75', minus: '0.75' })).toEqual({
			lower: '-0.25',
			upper: '1.25'
		});
	});

	test('a reference spec, no spec and no value are never flagged', () => {
		expect(specResult({ kind: 'reference', nominal: '80' }, 500)).toBe('none');
		expect(specResult(undefined, 5)).toBe('none');
		expect(specResult(range, '')).toBe('none');
		expect(specResult(range, 'abc')).toBe('invalid');
	});

	test('a spec reads with its unit symbol', () => {
		expect(specText(range, 'in')).toBe('12.125 – 12.25 in');
		expect(specText({ kind: 'nominal', nominal: '80', plus: '5', minus: '5' }, 'ft_lbf')).toBe('80 ± 5 ft·lbf');
		expect(specText({ kind: 'nominal', nominal: '80', plus: '5', minus: '2' }, 'ft_lbf')).toBe('80 +5 / −2 ft·lbf');
		expect(specText({ kind: 'min', lower: '3' }, 'mm')).toBe('≥ 3 mm');
		expect(specText({ kind: 'reference', nominal: '80' }, 'ft_lbf')).toBe('approx. 80 ft·lbf');
	});

	test('an upside-down range and negative tolerances are refused', () => {
		expect(zSpec.safeParse({ kind: 'range', lower: '2', upper: '1' }).success).toBe(false);
		expect(zSpec.safeParse({ kind: 'nominal', nominal: '2', plus: '-1', minus: '1' }).success).toBe(false);
		expect(zSpec.safeParse({ kind: 'range', lower: '1e3', upper: '2' }).success).toBe(false);
	});
});
