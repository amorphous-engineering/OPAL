import { type Part, type PartState, formatQty, notFound, parseQty, type Qty, type zPartCreate } from '@opal/shared';
import { and, desc, eq, like, lt, or } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../context.ts';
import { part } from '../db/schema/index.ts';
import { insert, update } from '../write.ts';

type Row = typeof part.$inferSelect;

export function toPart(r: Row): Part {
	return {
		id: r.id,
		internalPn: r.internalPn,
		externalPn: r.externalPn,
		name: r.name,
		description: r.description,
		category: r.category,
		unitOfMeasure: r.unitOfMeasure,
		trackingType: r.trackingType,
		procurement: r.procurement,
		tier: r.tier,
		reorderPoint: r.reorderPoint === null ? null : formatQty(r.reorderPoint as Qty),
		isTooling: r.isTooling,
		calibrationIntervalDays: r.calibrationIntervalDays,
		state: r.state,
		activatedAt: r.activatedAt,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

export function list(
	ctx: Ctx,
	input: { cursor?: string; limit: number; q?: string; state?: PartState }
) {
	const where = and(
		input.cursor ? lt(part.id, Number(input.cursor)) : undefined,
		input.state ? eq(part.state, input.state) : undefined,
		input.q ? or(like(part.name, `%${input.q}%`), like(part.internalPn, `%${input.q}%`)) : undefined
	);
	const rows = ctx.db
		.select()
		.from(part)
		.where(where)
		.orderBy(desc(part.id))
		.limit(input.limit + 1)
		.all();
	const page = rows.slice(0, input.limit);
	return {
		items: page.map(toPart),
		next: rows.length > input.limit ? String(page.at(-1)!.id) : null
	};
}

export function get(ctx: Ctx, id: number): Part {
	const row = ctx.db.select().from(part).where(eq(part.id, id)).get();
	if (!row) throw notFound('Part');
	return toPart(row);
}

export function create(ctx: Ctx, input: z.output<typeof zPartCreate>): Part {
	// Phase 0 numbering placeholder: the project numbering scheme is ported in
	// Phase 1. Insert with a temporary unique number, then derive it from the id.
	const row = insert(ctx, part, {
		internalPn: input.internalPn ?? `pending-${crypto.randomUUID()}`,
		externalPn: input.externalPn ?? null,
		name: input.name,
		description: input.description ?? null,
		category: input.category ?? null,
		unitOfMeasure: input.unitOfMeasure,
		trackingType: input.trackingType,
		procurement: input.procurement,
		tier: input.tier,
		reorderPoint: input.reorderPoint == null ? null : parseQty(input.reorderPoint),
		isTooling: input.isTooling,
		calibrationIntervalDays: input.calibrationIntervalDays ?? null,
		state: 'draft'
	});
	if (input.internalPn) return toPart(row);
	return toPart(update(ctx, part, row.id, { internalPn: `P-${String(row.id).padStart(5, '0')}` }));
}
