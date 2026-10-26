import { describe, expect, test } from 'bun:test';
import { canonicalDesignator, numberCodec, storeDesignator, variantFormat, type PartNumberScheme } from './designators.ts';

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

const variants: PartNumberScheme = { ...scheme, format: '{prefix}{sep}{tier_code}{sep}{sequence}{sep}{variant}' };
const bare: PartNumberScheme = {
	prefix: '',
	separator: '-',
	format: '{tier_code}{sep}{sequence}{sep}{variant}',
	tiers: [{ level: 1, code: '001', name: 'Flight' }]
};

describe('variant formats', () => {
	test('the variant suffix splits off with its joiner', () => {
		expect(variantFormat('{prefix}{sep}{tier_code}{sep}{sequence}{sep}{variant}')).toEqual({
			base: '{prefix}{sep}{tier_code}{sep}{sequence}',
			joiner: '{sep}',
			variants: true
		});
		expect(variantFormat('{tier_code}{sequence}/{variant}')).toEqual({ base: '{tier_code}{sequence}', joiner: '/', variants: true });
		expect(variantFormat('{tier_code}{sep}{sequence}-X{sep}{variant}')).toMatchObject({ base: '{tier_code}{sep}{sequence}-X', joiner: '{sep}' });
	});

	test('a format without {variant} is all base and joins a suffix with the separator', () => {
		expect(variantFormat('{prefix}{sep}{sequence}')).toEqual({ base: '{prefix}{sep}{sequence}', joiner: '{sep}', variants: false });
		expect(variantFormat('{variant}{sep}{sequence}').variants).toBe(false);
	});
});

describe('part numbers with variants', () => {
	const c = numberCodec(4, variants);

	test('a stored number shows the sequence at the setting width and the variant at 3 digits', () => {
		expect(c.display('SPX-F-0000001337-001')).toBe('SPX-F-1337-001');
		expect(c.display('SPX-F-0000001337-012')).toBe('SPX-F-1337-012');
		expect(numberCodec(6, variants).display('SPX-F-0000001337-002')).toBe('SPX-F-001337-002');
		expect(numberCodec(3, variants).display('SPX-F-0000000004-003')).toBe('SPX-F-004-003');
	});

	test('a legacy number without a suffix still shows', () => {
		expect(c.display('SPX-F-0000000132')).toBe('SPX-F-0132');
	});

	test('text rewriting keeps the suffix and finds numbers with and without one', () => {
		expect(c.display('SPX-F-0000001337-002 replaces SPX-F-0000000132 in SPX-D-0000000007-003.')).toBe(
			'SPX-F-1337-002 replaces SPX-F-0132 in SPX-D-0007-003.'
		);
		expect(c.display('(SPX-F-0000001337-001)')).toBe('(SPX-F-1337-001)');
		expect(c.display('/parts?q=SPX-F-0000001337')).toBe('/parts?q=SPX-F-1337');
	});

	test('text rewriting leaves a suffix that is not 3 digits in place', () => {
		expect(c.display('SPX-F-0000001337-0012')).toBe('SPX-F-1337-0012');
		expect(c.display('SPX-F-0000001337-01')).toBe('SPX-F-1337-01');
		expect(c.display('SPX-F-0000001337-001A')).toBe('SPX-F-1337-001A');
	});

	test('a base number at any width is the stored base', () => {
		for (const v of ['SPX-F-1337', 'SPX-F-01337', 'SPX-F-0000001337', ' SPX-F-1337 ']) {
			expect(c.canonical(v)).toBe('SPX-F-0000001337');
		}
	});

	test('a full number keeps its variant', () => {
		for (const v of ['SPX-F-1337-002', 'SPX-F-01337-002', 'SPX-F-0000001337-002', 'SPX-F-1337-2', 'SPX-F-1337-02']) {
			expect(c.canonical(v)).toBe('SPX-F-0000001337-002');
		}
	});

	test('text that is not a number is left alone', () => {
		for (const v of ['SPX-F-1337-', 'SPX-F-1337-0002', 'SPX-F-1337-ABC', 'SPX-Q-1337-001', 'WO-4-001']) {
			expect(c.canonical(v)).toBe(v);
		}
	});

	test('a search for the base finds every variant of it', () => {
		const q = c.search('SPX-F-1337');
		expect(q).toBe('SPX-F-0000001337');
		for (const pn of ['SPX-F-0000001337', 'SPX-F-0000001337-001', 'SPX-F-0000001337-002']) expect(pn).toContain(q);
		expect('SPX-F-0000001338-001').not.toContain(q);
		expect(c.search('SPX-F-01337')).toBe('SPX-F-0000001337');
	});

	test('a search for a variant finds it at any code width, and a leading zero starts a partial code', () => {
		expect(c.search('SPX-F-1337-002')).toBe('SPX-F-0000001337-002');
		expect(c.search('SPX-F-1337-2')).toBe('SPX-F-0000001337-002');
		expect(c.search('SPX-F-1337-12')).toBe('SPX-F-0000001337-012');
		expect(c.search('SPX-F-1337-00')).toBe('SPX-F-0000001337-00');
		expect(c.search('SPX-F-1337-')).toBe('SPX-F-0000001337-');
		expect(c.search('SPX-F-0001-0')).toBe('SPX-F-0000000001-0');
	});

	test('a partial sequence still searches as a partial sequence', () => {
		expect(c.search('SPX-F-01')).toBe('SPX-F-00000001');
		expect(c.search('strut')).toBe('strut');
	});

	test('split gives the base and the variant code', () => {
		expect(c.split('SPX-F-0000001337-003')).toEqual({ base: 'SPX-F-0000001337', variant: '003' });
		expect(c.split('SPX-F-0000001337')).toEqual({ base: 'SPX-F-0000001337', variant: null });
		expect(c.split('SPX-F-1337-003')).toBeNull();
		expect(c.split('LEGACY-12')).toBeNull();
	});

	test('a format without a prefix, a numeric tier code and a 3-digit width', () => {
		const b = numberCodec(4, bare);
		expect(b.display('001-0000001337-002')).toBe('001-1337-002');
		expect(b.canonical('001-1337')).toBe('001-0000001337');
		expect(b.canonical('001-1337-003')).toBe('001-0000001337-003');
		expect(b.search('001-1337')).toBe('001-0000001337');
		const three = numberCodec(3, bare);
		expect(three.display('001-0000000001-001')).toBe('001-001-001');
		expect(three.canonical('001-001-001')).toBe('001-0000000001-001');
		expect(three.search('001-001')).toBe('001-0000000001');
	});

	test('a separator and joiner other than a dash', () => {
		const s: PartNumberScheme = { prefix: 'RV.1', separator: '.', format: '{prefix}{sep}{tier_code}{sep}{sequence}/{variant}', tiers: scheme.tiers };
		const d = numberCodec(4, s);
		expect(d.display('RV.1.F.0000000042/002')).toBe('RV.1.F.0042/002');
		expect(d.canonical('RV.1.F.42/2')).toBe('RV.1.F.0000000042/002');
		expect(d.canonical('RV.1.F.42')).toBe('RV.1.F.0000000042');
		expect(d.search('RV.1.F.42')).toBe('RV.1.F.0000000042');
		expect(d.display('RVx1.F.0000000042/002')).toBe('RVx1.F.0000000042/002');
	});
});

describe('part numbers with variants off', () => {
	const c = numberCodec(4, scheme);

	test('numbers without a suffix work as before', () => {
		expect(c.display('SPX-F-0000000132')).toBe('SPX-F-0132');
		expect(c.canonical('SPX-F-132')).toBe('SPX-F-0000000132');
		expect(c.split('SPX-F-0000000132')).toEqual({ base: 'SPX-F-0000000132', variant: null });
	});

	test('variants made before variants were turned off still read', () => {
		expect(c.display('SPX-F-0000000132-002')).toBe('SPX-F-0132-002');
		expect(c.canonical('SPX-F-132-002')).toBe('SPX-F-0000000132-002');
		expect(c.search('SPX-F-132-002')).toBe('SPX-F-0000000132-002');
		expect(c.split('SPX-F-0000000132-002')).toEqual({ base: 'SPX-F-0000000132', variant: '002' });
	});

	test('with no separator a suffix cannot be told from the sequence and is not read', () => {
		const none = numberCodec(4, { ...scheme, separator: '', format: '{prefix}{tier_code}{sequence}' });
		expect(none.display('SPXF0000000132')).toBe('SPXF0132');
		expect(none.split('SPXF0000000132')).toEqual({ base: 'SPXF0000000132', variant: null });
		expect(none.canonical('SPXF132')).toBe('SPXF0000000132');
	});

	test('the fallback scheme reads a suffix too', () => {
		const f = numberCodec(4);
		expect(f.display('PN-1-0000000003-002')).toBe('PN-1-0003-002');
		expect(f.canonical('PN-1-3-2')).toBe('PN-1-0000000003-002');
	});
});
