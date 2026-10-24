/**
 * Gates: named permissions that roles grant. Admins hold every gate.
 * Extend this list as areas are ported.
 */
export const GATES = ['parts.read', 'parts.write', 'users.admin'] as const;
export type Gate = (typeof GATES)[number];
