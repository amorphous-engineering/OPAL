/**
 * What references a part. A referenced part cannot be deleted, and its tracking type cannot
 * change under existing stock. Parts own the BOM counts; every other area registers its own
 * count at module load (inventory: stock records, purchasing: PO lines, ...).
 */
import { eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { bomLine } from '../../db/schema/index.ts';

export interface PartReference {
	/** Key in the `references` map, e.g. `inventory_records`. */
	name: string;
	count(ctx: Pick<Ctx, 'db'>, partId: number): number;
	/** True when these rows describe the tracking type (stock records do). */
	locksTracking?: boolean;
}

const sources = new Map<string, PartReference>();

export function registerPartReference(ref: PartReference): void {
	sources.set(ref.name, ref);
}

function countBom(ctx: Pick<Ctx, 'db'>, column: 'assemblyId' | 'componentId', partId: number): number {
	return (
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(bomLine)
			.where(eq(bomLine[column], partId))
			.get()?.n ?? 0
	);
}

registerPartReference({ name: 'bom_components', count: (ctx, id) => countBom(ctx, 'assemblyId', id) });
registerPartReference({ name: 'used_in_assemblies', count: (ctx, id) => countBom(ctx, 'componentId', id) });

/** Nonzero reference counts by name. */
export function referenceCounts(ctx: Pick<Ctx, 'db'>, partId: number): Record<string, number> {
	const out: Record<string, number> = {};
	for (const ref of sources.values()) {
		const n = ref.count(ctx, partId);
		if (n > 0) out[ref.name] = n;
	}
	return out;
}

export function hasTrackingLock(ctx: Pick<Ctx, 'db'>, partId: number): boolean {
	for (const ref of sources.values()) if (ref.locksTracking && ref.count(ctx, partId) > 0) return true;
	return false;
}
