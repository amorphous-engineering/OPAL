/** What a scoped token (a plugin's) may call. Sessions and unscoped tokens have no such limit. */
import { matchesPattern, OpalError } from '@opal/shared';
import type { Actor } from '../context.ts';

/**
 * Passes when the token's scope names any of `names`. Operations check their own name. Raw routes
 * have no contract, so they name a permission here, and a manifest declares it like an operation.
 */
export function requireScope(actor: Actor, ...names: string[]): void {
	if (actor.kind !== 'token' || !actor.scopes) return;
	const { ops } = actor.scopes;
	if (!names.some((name) => matchesPattern(ops, name))) {
		throw new OpalError(403, 'out_of_scope', `This token may not call ${names[0]}`);
	}
}
