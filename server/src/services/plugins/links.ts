/** External links: a record's counterpart in another system, written by the plugin that syncs it. */
import { and, eq } from 'drizzle-orm';
import { forbidden, notFound, type ExternalLink, type LinkEntity } from '@opal/shared';
import { actorUserId, type Ctx } from '../../context.ts';
import { execution, externalLink, issue, part, plugin, project } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { pluginOfUser, type PluginRow } from './store.ts';

const TABLES = { issue, part, execution, project } as const;

/** Only a plugin's own user may write links, and only its own. */
function callerPlugin(ctx: Ctx): PluginRow {
	const userId = actorUserId(ctx.actor);
	const row = userId === null ? undefined : pluginOfUser(ctx.db, userId);
	if (!row) throw forbidden('Only a plugin can change external links');
	return row;
}

function assertEntity(ctx: Ctx, type: LinkEntity, id: number): void {
	const table = TABLES[type];
	if (!ctx.db.select({ id: table.id }).from(table).where(eq(table.id, id)).get()) throw notFound(`Record ${type} ${id}`);
}

function view(row: typeof externalLink.$inferSelect, owner: PluginRow): ExternalLink {
	return {
		id: row.id,
		plugin: owner.key,
		pluginName: owner.manifest.name,
		entityType: row.entityType,
		entityId: row.entityId,
		externalId: row.externalId,
		url: row.url,
		label: row.label,
		updatedAt: row.updatedAt
	};
}

export function listLinks(ctx: Ctx, entityType: LinkEntity, entityId: number): ExternalLink[] {
	return ctx.db
		.select({ l: externalLink, p: plugin })
		.from(externalLink)
		.innerJoin(plugin, eq(plugin.id, externalLink.pluginId))
		.where(and(eq(externalLink.entityType, entityType), eq(externalLink.entityId, entityId)))
		.orderBy(externalLink.id)
		.all()
		.map((r) => view(r.l, r.p));
}

export interface LinkInput {
	entityType: LinkEntity;
	entityId: number;
	externalId: string;
	url: string;
	label?: string | null;
}

export function setLink(ctx: Ctx, input: LinkInput): ExternalLink {
	const owner = callerPlugin(ctx);
	assertEntity(ctx, input.entityType, input.entityId);
	const existing = ctx.db
		.select()
		.from(externalLink)
		.where(
			and(
				eq(externalLink.pluginId, owner.id),
				eq(externalLink.entityType, input.entityType),
				eq(externalLink.entityId, input.entityId),
				eq(externalLink.externalId, input.externalId)
			)
		)
		.get();
	const values = { url: input.url, label: input.label ?? null };
	const row = existing
		? update(ctx, externalLink, existing.id, values)
		: insert(ctx, externalLink, {
				pluginId: owner.id,
				entityType: input.entityType,
				entityId: input.entityId,
				externalId: input.externalId,
				...values
			});
	return view(row, owner);
}

/** Removing a link that is already gone succeeds: a sync can repeat. */
export function removeLink(ctx: Ctx, input: Pick<LinkInput, 'entityType' | 'entityId' | 'externalId'>): void {
	const owner = callerPlugin(ctx);
	const existing = ctx.db
		.select()
		.from(externalLink)
		.where(
			and(
				eq(externalLink.pluginId, owner.id),
				eq(externalLink.entityType, input.entityType),
				eq(externalLink.entityId, input.entityId),
				eq(externalLink.externalId, input.externalId)
			)
		)
		.get();
	if (existing) remove(ctx, externalLink, existing.id);
}
