/**
 * Role marks: a short code in a coloured square beside a step, saying who does it. The letters
 * carry the meaning; the colour lets an operator follow a role down the page without reading.
 * The palette leaves out red, amber, green, blue and yellow, which mean state.
 */
import { z } from 'zod';

export const ROLE_COLORS = ['purple', 'teal', 'brown', 'magenta', 'slate'] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];
export const zRoleColor = z.enum(ROLE_COLORS);

/** One to three capital letters or digits: LD, LO, RSO. */
export const zRoleCode = z
	.string()
	.max(16)
	.trim()
	.transform((s) => s.toUpperCase())
	.pipe(z.string().max(3).regex(/^[A-Z0-9]{1,3}$/, 'One to three letters or digits'));

/**
 * The mark as a step shows it. `color` is null for a role that no longer exists, which draws an
 * outline instead of a fill.
 */
export const zRoleMark = z.object({
	name: z.string(),
	code: z.string(),
	color: zRoleColor.nullable()
});
export type RoleMark = z.infer<typeof zRoleMark>;

/** The default code: initials of the first two words, or the first two letters of one word. */
export function roleInitials(name: string): string {
	const words = name.trim().split(/[\s\-_/]+/).filter((w) => /[A-Za-z0-9]/.test(w));
	const letters = (w: string) => w.replace(/[^A-Za-z0-9]/g, '');
	if (words.length >= 2) return (letters(words[0]!)[0]! + letters(words[1]!)[0]!).toUpperCase();
	return letters(words[0] ?? '').slice(0, 2).toUpperCase() || '?';
}

/** The default colour of the nth role offered together (1-based): the palette in turn. */
export const defaultRoleColor = (n: number): RoleColor => ROLE_COLORS[(Math.max(n, 1) - 1) % ROLE_COLORS.length]!;
