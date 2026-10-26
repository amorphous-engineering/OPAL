import { plugins } from '@opal/shared';
import { actorUserId } from '../context.ts';
import { implement, type Impl } from '../registry.ts';
import { panelsFor } from '../services/plugins/panels.ts';
import { listLinks, removeLink, setLink } from '../services/plugins/links.ts';

export const pluginsLinkImpls: Impl[] = [
	implement(plugins.panels, (ctx, input) => ({ items: panelsFor(ctx.db, actorUserId(ctx.actor)!, input.slot) })),
	implement(plugins.links.list, (ctx, input) => ({ items: listLinks(ctx, input.entityType, input.entityId) })),
	implement(plugins.links.set, (ctx, input) => setLink(ctx, input)),
	implement(plugins.links.remove, (ctx, input) => {
		removeLink(ctx, input);
		return { ok: true as const };
	})
];
