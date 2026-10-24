/**
 * Gates: privileged actions that roles grant. Admins hold every gate. `admin`
 * is held by admins only. Everything else needs only a signed-in actor.
 */
export const GATES = ['admin', 'issue.disposition', 'issue.approve'] as const;
export type Gate = (typeof GATES)[number];
