import { describe, expect, test } from 'bun:test';
import { canonicalDesignator, numberCodec, storeDesignator, type PartNumberScheme } from './designators.ts';

const scheme: PartNumberScheme = {
	prefix: 'SPX',
	separator: '-',
	format: '{prefix}{sep}{tier_code}{sep}{sequence}',
	tiers: [
		{ level: 1, code: 'F', name: 'Flight' },
		{ level: 3, code: 'D', name: 'Dev' }
	]
};

describe('sequence numbers', () => {
	test('a new number is stored with a 10-digit sequence', () => {
		expect(storeDesignator('WO', 4)).toBe('WO-0000000004');
	});

	test('a number typed at any width means the same stored number', () => {
		for (const v of ['WO-4', 'WO-0004', 'WO-00004', 'wo-4']) expect(canonicalDesignator(v)).toBe('WO-0000000004');
		const c = numberCodec(4, scheme);
		for (const v of ['SPX-F-132', 'SPX-F-0132', 'SPX-F-00132']) expect(c.canonical(v)).toBe('SPX-F-0000000132');
	});

	test('text that is not a number is left alone', () => {
		const c = numberCodec(4, scheme);
		for (const v of ['T-1 rocket', 'LOT-0004', 'PO-12A', 'SPX-Q-0001', 'Tank']) expect(c.canonical(v)).toBe(v);
	});

	test('stored numbers show at the setting width, also inside prose, and are never cut', () => {
		const c = numberCodec(4, scheme);
		expect(c.display('WO-0000000004')).toBe('WO-0004');
		expect(c.display('IT-0000000003 assigned to you')).toBe('IT-0003 assigned to you');
		expect(c.display('SPX-F-0000000132')).toBe('SPX-F-0132');
		expect(c.display('OPAL-0000123456')).toBe('OPAL-123456');
		expect(numberCodec(6, scheme).display('WO-0000000004')).toBe('WO-000004');
	});

	test('display leaves numbers that are not at the stored width alone', () => {
		const c = numberCodec(4, scheme);
		expect(c.display('WO-00004')).toBe('WO-00004');
		expect(c.display('/inventory/opal/OPAL-0000000186')).toBe('/inventory/opal/OPAL-0186');
	});

	test('a search for a whole or partial number becomes what the stored form contains', () => {
		const c = numberCodec(4, scheme);
		expect(c.search('WO-0004')).toBe('WO-0000000004');
		expect(c.search('WO-00')).toBe('WO-00000000');
		expect(c.search('WO-00004')).toBe('WO-0000000004');
		expect(c.search('WO-4')).toBe('WO-0000000004');
		expect(c.search('SPX-F-01')).toBe('SPX-F-00000001');
		expect(c.search('valve')).toBe('valve');
	});
});
