import { describe, expect, test } from 'bun:test';
import { defaultRoleColor, ROLE_COLORS, roleInitials, zRoleCode } from './role-marks.ts';

describe('role marks', () => {
	test('a role is marked by its initials until someone sets the letters', () => {
		expect(roleInitials('Launch Director')).toBe('LD');
		expect(roleInitials('Range Safety Officer')).toBe('RS');
		expect(roleInitials('Technician')).toBe('TE');
		expect(roleInitials('pad-crew')).toBe('PC');
	});

	test('letters are one to three capitals or digits', () => {
		expect(zRoleCode.parse(' lo ')).toBe('LO');
		expect(zRoleCode.parse('RSO')).toBe('RSO');
		expect(zRoleCode.safeParse('LDXX').success).toBe(false);
		expect(zRoleCode.safeParse('L D').success).toBe(false);
	});

	test('new roles take the palette in turn', () => {
		expect(ROLE_COLORS.map((_, i) => defaultRoleColor(i + 1))).toEqual([...ROLE_COLORS]);
		expect(defaultRoleColor(ROLE_COLORS.length + 1)).toBe(ROLE_COLORS[0]);
	});
});
