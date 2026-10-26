import { contracts, forbidden } from '@opal/shared';
import { actorUserId, type Ctx } from '../context.ts';
import { type Impl, implement } from '../registry.ts';
import { dbPath } from '../paths.ts';
import { VERSION } from '../version.ts';
import * as attachments from '../services/platform/attachments.ts';
import * as audit from '../services/platform/audit.ts';
import { health } from '../services/platform/health.ts';
import { subscriberCount } from '../services/platform/events.ts';
import * as notifications from '../services/platform/notifications.ts';
import * as presence from '../services/platform/presence.ts';
import * as search from '../services/platform/search.ts';
import * as undo from '../services/platform/undo.ts';
import '../services/platform/builtin.ts';

const c = contracts.platform;

/** Inbox and presence belong to a person: a system actor has none. */
function me(ctx: Ctx): number {
	const id = actorUserId(ctx.actor);
	if (id === null) throw forbidden('This needs a signed-in person');
	return id;
}

export const platformImpls = [
	implement(c.health, (ctx) => health(ctx.db)),
	implement(c.about, async () => {
		// Imported here: ops/index.ts imports this file.
		const { impls } = await import('./index.ts');
		return {
			version: VERSION,
			isDev: VERSION.includes('-dev'),
			dbPath: dbPath(),
			operations: impls.map((i) => ({ name: i.contract.name, method: i.contract.method, path: i.contract.path }))
		};
	}),
	implement(c.attachments.list, (ctx, i) =>
		attachments.listFor(ctx, { type: i.ownerType, id: i.ownerId }, i.kind)
	),
	implement(c.attachments.update, (ctx, i) => {
		attachments.guardChange(ctx, i.id, 'patch');
		return attachments.patch(ctx, i.id, i);
	}),
	implement(c.attachments.delete, (ctx, i) => {
		attachments.guardChange(ctx, i.id, 'detach');
		attachments.detach(ctx, i.id);
		return { ok: true as const };
	}),
	implement(c.events.stats, () => ({ connectedClients: subscriberCount() })),
	implement(c.presence.heartbeat, (ctx, i) => ({
		online: presence.heartbeat(ctx.db, me(ctx), i.activity)
	})),
	implement(c.presence.list, (ctx) => ({ online: presence.listOnline(ctx.db) })),
	implement(c.notifications.list, (ctx, i) => notifications.list(ctx, me(ctx), i)),
	implement(c.notifications.unreadCount, (ctx) => ({
		unreadCount: notifications.unreadCount(ctx, me(ctx))
	})),
	implement(c.notifications.readAll, (ctx) => ({ markedRead: notifications.markAllRead(ctx, me(ctx)) })),
	implement(c.notifications.read, (ctx, i) => notifications.markRead(ctx, me(ctx), i.id)),
	implement(c.notifications.dismiss, (ctx, i) => notifications.dismiss(ctx, me(ctx), i.id)),
	implement(c.audit.list, (ctx, i) => audit.list(ctx, i)),
	implement(c.audit.facets, (ctx) => audit.facets(ctx)),
	implement(c.audit.history, (ctx, i) => audit.history(ctx, i.entity, i.entityId, i)),
	implement(c.undo.preview, (ctx) => undo.preview(ctx)),
	implement(c.undo.last, (ctx) => undo.undoLast(ctx)),
	implement(c.search.query, (ctx, i) => search.search(ctx, i.q, i.limit))
] as Impl[];
