/**
 * Part lifecycle: draft -> active -> obsolete. A draft's number and tier can change; activation
 * locks them for good and is always a deliberate act, never a side effect of using the part.
 * Anything that commits a part to the physical world refuses drafts through ensurePartsActive.
 */
import { conflict, forbidden, OpalError, type Part, now } from '@opal/shared';
import { eq, inArray } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { part, user } from '../../db/schema/index.ts';
import { update } from '../../write.ts';
import { getSetting } from '../org/settings.ts';
import { getRow, present } from './index.ts';

/** App setting: the user an admin authorised to activate parts through an API token. */
export const AGENT_ACTIVATION_SETTING = 'mcp_agent_activation_operator_id';

/**
 * Refuse when any of the parts is a draft. Throws 409 `draft_parts_blocked` that names each
 * draft; the remedy is to activate them, which this function never does itself.
 */
export function ensurePartsActive(ctx: Pick<Ctx, 'db'>, partIds: Iterable<number | null | undefined>, action: string): void {
	const ids = [...new Set([...partIds].filter((x): x is number => typeof x === 'number'))];
	if (!ids.length) return;
	const drafts = ctx.db
		.select()
		.from(part)
		.where(inArray(part.id, ids))
		.orderBy(part.id)
		.all()
		.filter((p) => p.state === 'draft');
	if (!drafts.length) return;
	const pns = drafts.map((p) => p.internalPn).join(', ');
	throw new OpalError(
		409,
		'draft_parts_blocked',
		`${drafts.length} draft part(s) block ${action}: ${pns}. Activate them, then retry.`,
		Object.fromEntries(drafts.map((p) => [`part.${p.id}`, `${p.internalPn} ${p.name} is a draft`]))
	);
}

/** Who an activation is attributed to, and the cause text. Tokens need an admin's opt-in. */
function activator(ctx: Ctx, cause: string): { userId: number | null; cause: string } {
	if (ctx.actor.kind !== 'token') return { userId: actorUserId(ctx.actor), cause };
	const raw = getSetting(ctx.db, AGENT_ACTIVATION_SETTING);
	const operator = raw
		? ctx.db.select().from(user).where(eq(user.id, Number(raw))).get()
		: undefined;
	if (!operator || !operator.isActive) {
		throw forbidden(
			'Agent part activation is disabled. An admin can enable it in Settings, or a person can activate the part in OPAL.'
		);
	}
	return { userId: operator.id, cause: `${cause} (API token, authorized by ${operator.name})` };
}

function activateRow(ctx: Ctx, id: number, who: { userId: number | null; cause: string }) {
	const row = getRow(ctx, id);
	if (row.state !== 'draft') throw conflict('wrong_state', `${row.internalPn} is already ${row.state}`);
	return update(ctx, part, id, {
		state: 'active',
		activatedAt: now(),
		activatedById: who.userId,
		activationCause: who.cause
	});
}

export function activate(ctx: Ctx, id: number, cause?: string): Part {
	getRow(ctx, id);
	return present(ctx, activateRow(ctx, id, activator(ctx, cause ?? 'manual activation from part page')));
}

export function activateMany(ctx: Ctx, ids: number[], cause?: string) {
	const who = activator(ctx, cause ?? 'bulk activation');
	const activated: Part[] = [];
	const skipped: { id: number; reason: string }[] = [];
	for (const id of new Set(ids)) {
		try {
			activated.push(present(ctx, activateRow(ctx, id, who)));
		} catch (e) {
			if (e instanceof OpalError && (e.status === 409 || e.status === 404)) skipped.push({ id, reason: e.message });
			else throw e;
		}
	}
	return { activated, skipped };
}

/** Retire an active part. Records that reference it keep working. */
export function obsolete(ctx: Ctx, id: number, cause?: string): Part {
	const row = getRow(ctx, id);
	if (row.state !== 'active') {
		throw conflict('wrong_state', `${row.internalPn} is ${row.state}: only an active part can become obsolete`);
	}
	return present(
		ctx,
		update(ctx, part, id, {
			state: 'obsolete',
			obsoletedAt: now(),
			obsoletedById: actorUserId(ctx.actor),
			obsoleteCause: cause ?? 'marked obsolete from part page'
		})
	);
}

