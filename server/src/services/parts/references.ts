/**
 * What references a part. A referenced part cannot be deleted, and its tracking type cannot
 * change under existing stock. Parts own the BOM counts; every other area registers its own
 * count at module load (inventory: stock records, purchasing: PO lines, ...).
 */
import { eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { bomLine, part } from '../../db/schema/index.ts';

export interface PartReference {
	/** Key in the `references` map, e.g. `inventory_records`. */
	name: string;
	count(ctx: Pick<Ctx, 'db'>, partId: number): number;
	/** True when these rows describe the tracking type (stock records do). */
	locksTracking?: boolean;
	/** True when these rows are committed quantities counted in the part's unit (stock, PO lines). */
	locksUnit?: boolean;
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

/** A kind of physical copy of a part, or one committed to exist. Each area registers its own. */
export interface PartCopies {
	/** Singular and plural, for the message that says why a BOM is locked. */
	label: [string, string];
	count(ctx: Pick<Ctx, 'db'>, partId: number): number;
}

const copySources: PartCopies[] = [];

export function registerPartCopies(source: PartCopies): void {
	copySources.push(source);
}

/** What exists of this part, in words ("2 stock records, 1 work order"), or null if nothing does. */
export function copiesOf(ctx: Pick<Ctx, 'db'>, partId: number): string | null {
	const found = copySources.flatMap((s) => {
		const n = s.count(ctx, partId);
		return n > 0 ? [`${n} ${s.label[n === 1 ? 0 : 1]}`] : [];
	});
	return found.length ? found.join(', ') : null;
}

/**
 * The assembly with copies whose BOM names this part, if any. Those copies were built to that line, and
 * the line reads through the part: its number and its unit say what the quantity means.
 */
export function lockedAssemblyUsing(ctx: Pick<Ctx, 'db'>, partId: number): string | null {
	const assemblies = ctx.db
		.select({ id: part.id, internalPn: part.internalPn })
		.from(bomLine)
		.innerJoin(part, eq(part.id, bomLine.assemblyId))
		.where(eq(bomLine.componentId, partId))
		.all();
	return assemblies.find((a) => copySources.some((s) => s.count(ctx, a.id) > 0))?.internalPn ?? null;
}

export interface PublishedKit {
	procedureId: number;
	templateNumber: string;
	name: string;
	versionNumber: number;
}

let publishedKitReader: (ctx: Pick<Ctx, 'db'>, partId: number) => PublishedKit[] = () => [];

/** The procedures area says which current published versions output a part. */
export function registerPublishedKits(fn: typeof publishedKitReader): void {
	publishedKitReader = fn;
}

export const publishedKits = (ctx: Pick<Ctx, 'db'>, partId: number) => publishedKitReader(ctx, partId);

/** Nonzero reference counts by name. */
export function referenceCounts(ctx: Pick<Ctx, 'db'>, partId: number): Record<string, number> {
	const out: Record<string, number> = {};
	for (const ref of sources.values()) {
		const n = ref.count(ctx, partId);
		if (n > 0) out[ref.name] = n;
	}
	return out;
}

/** A new unit would silently change what every one of these quantities means. */
export function hasUnitLock(ctx: Pick<Ctx, 'db'>, partId: number): boolean {
	for (const ref of sources.values()) if (ref.locksUnit && ref.count(ctx, partId) > 0) return true;
	return lockedAssemblyUsing(ctx, partId) !== null;
}

export function hasTrackingLock(ctx: Pick<Ctx, 'db'>, partId: number): boolean {
	for (const ref of sources.values()) if (ref.locksTracking && ref.count(ctx, partId) > 0) return true;
	return false;
}
