/** Bill of materials: what goes into an assembly. `bom_line` is the only home of structure. */
import {
	type BomLine,
	type BomTreeNode,
	conflict,
	formatQty,
	notFound,
	OpalError,
	type Qty,
	parseQty
} from '@opal/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Ctx } from '../../context.ts';
import { bomLine, part } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';

const assembly = alias(part, 'assembly');
const component = alias(part, 'component');

function select(ctx: Pick<Ctx, 'db'>, where: ReturnType<typeof eq>): BomLine[] {
	const rows = ctx.db
		.select({ line: bomLine, assembly, component })
		.from(bomLine)
		.innerJoin(assembly, eq(bomLine.assemblyId, assembly.id))
		.innerJoin(component, eq(bomLine.componentId, component.id))
		.where(where)
		.orderBy(asc(bomLine.id))
		.all();
	return rows.map(({ line, assembly: a, component: c }) => ({
		id: line.id,
		assemblyId: a.id,
		assemblyPn: a.internalPn,
		assemblyName: a.name,
		componentId: c.id,
		componentPn: c.internalPn,
		componentName: c.name,
		componentExternalPn: c.externalPn,
		componentTier: c.tier,
		componentState: c.state,
		quantity: formatQty(line.quantity as Qty),
		referenceDesignator: line.referenceDesignator,
		notes: line.notes,
		createdAt: line.createdAt,
		updatedAt: line.updatedAt
	}));
}

function requirePart(ctx: Pick<Ctx, 'db'>, id: number, what: string) {
	const row = ctx.db.select().from(part).where(eq(part.id, id)).get();
	if (!row) throw notFound(what);
	return row;
}

export function listLines(ctx: Pick<Ctx, 'db'>, assemblyId: number): BomLine[] {
	requirePart(ctx, assemblyId, 'Part');
	return select(ctx, eq(bomLine.assemblyId, assemblyId));
}

export function whereUsedLines(ctx: Pick<Ctx, 'db'>, componentId: number): BomLine[] {
	requirePart(ctx, componentId, 'Part');
	return select(ctx, eq(bomLine.componentId, componentId));
}

function lineView(ctx: Pick<Ctx, 'db'>, id: number): BomLine {
	const line = select(ctx, eq(bomLine.id, id))[0];
	if (!line) throw notFound('BOM line');
	return line;
}

function positiveQty(value: string): number {
	const q = parseQty(value);
	if (q <= 0) throw new OpalError(422, 'invalid_input', 'Invalid input', { quantity: 'must be above zero' });
	return q;
}

/** True when `target` appears anywhere under `root` in the BOM. */
function contains(ctx: Pick<Ctx, 'db'>, rootId: number, targetId: number): boolean {
	const seen = new Set<number>();
	let frontier = new Set([rootId]);
	while (frontier.size) {
		if (frontier.has(targetId)) return true;
		for (const id of frontier) seen.add(id);
		const rows = ctx.db
			.select({ id: bomLine.componentId })
			.from(bomLine)
			.where(inArray(bomLine.assemblyId, [...frontier]))
			.all();
		frontier = new Set(rows.map((r) => r.id).filter((id) => !seen.has(id)));
	}
	return false;
}

export function addLine(
	ctx: Ctx,
	input: {
		assemblyId: number;
		componentId: number;
		quantity: string;
		referenceDesignator?: string | null;
		notes?: string | null;
	}
): BomLine {
	const asm = requirePart(ctx, input.assemblyId, 'Assembly part');
	const comp = requirePart(ctx, input.componentId, 'Component part');
	if (asm.id === comp.id) {
		throw new OpalError(422, 'invalid_input', 'A part cannot be a component of itself', {
			componentId: 'must differ from the assembly'
		});
	}
	const quantity = positiveQty(input.quantity);
	// A component that already contains this assembly, at any depth, would close a loop.
	if (contains(ctx, comp.id, asm.id)) {
		throw conflict(
			'bom_loop',
			`${comp.internalPn} already contains ${asm.internalPn} in its BOM; adding it would create a loop`
		);
	}
	const dup = select(ctx, eq(bomLine.assemblyId, asm.id)).find((l) => l.componentId === comp.id);
	if (dup) {
		throw conflict('duplicate', `${comp.internalPn} is already in the BOM of ${asm.internalPn}`);
	}
	const row = insert(ctx, bomLine, {
		assemblyId: asm.id,
		componentId: comp.id,
		quantity,
		referenceDesignator: input.referenceDesignator?.trim() || null,
		notes: input.notes?.trim() || null
	});
	return lineView(ctx, row.id);
}

export function updateLine(
	ctx: Ctx,
	input: { lineId: number; quantity?: string; referenceDesignator?: string | null; notes?: string | null }
): BomLine {
	const row = ctx.db.select().from(bomLine).where(eq(bomLine.id, input.lineId)).get();
	if (!row) throw notFound('BOM line');
	const patch: Partial<typeof bomLine.$inferInsert> = {};
	if (input.quantity !== undefined) patch.quantity = positiveQty(input.quantity);
	if (input.referenceDesignator !== undefined) patch.referenceDesignator = input.referenceDesignator?.trim() || null;
	if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
	if (Object.keys(patch).length) update(ctx, bomLine, row.id, patch);
	return lineView(ctx, row.id);
}

export function removeLine(ctx: Ctx, lineId: number): void {
	const row = ctx.db.select().from(bomLine).where(eq(bomLine.id, lineId)).get();
	if (!row) throw notFound('BOM line');
	remove(ctx, bomLine, lineId);
}

/**
 * The BOM of an assembly as a tree. Lines load one query per depth, then the tree builds in
 * memory. A part that already appears above a node is marked `circular` and not expanded
 * (loops cannot be created through addLine, but imported data may hold one).
 */
export function tree(ctx: Pick<Ctx, 'db'>, rootId: number, depth: number): BomTreeNode {
	const root = requirePart(ctx, rootId, 'Part');
	const byAssembly = new Map<number, { line: typeof bomLine.$inferSelect; part: typeof part.$inferSelect }[]>();
	const fetched = new Set<number>();
	let frontier = new Set([rootId]);
	for (let level = 0; frontier.size && level < depth; level++) {
		for (const id of frontier) fetched.add(id);
		const rows = ctx.db
			.select({ line: bomLine, part })
			.from(bomLine)
			.innerJoin(part, eq(bomLine.componentId, part.id))
			.where(inArray(bomLine.assemblyId, [...frontier]))
			.orderBy(asc(bomLine.id))
			.all();
		const next = new Set<number>();
		for (const r of rows) {
			const list = byAssembly.get(r.line.assemblyId) ?? [];
			list.push(r);
			byAssembly.set(r.line.assemblyId, list);
			if (!fetched.has(r.part.id)) next.add(r.part.id);
		}
		frontier = next;
	}
	const node = (
		p: typeof part.$inferSelect,
		quantity: number,
		ref: string | null,
		path: ReadonlySet<number>,
		level: number
	): BomTreeNode => {
		const circular = path.has(p.id);
		const below = new Set(path).add(p.id);
		return {
			partId: p.id,
			internalPn: p.internalPn,
			name: p.name,
			externalPn: p.externalPn,
			tier: p.tier,
			state: p.state,
			quantity: formatQty(quantity as Qty),
			referenceDesignator: ref,
			circular,
			children:
				circular || level >= depth
					? []
					: (byAssembly.get(p.id) ?? []).map((r) => node(r.part, r.line.quantity, r.line.referenceDesignator, below, level + 1))
		};
	};
	return node(root, 10000, null, new Set(), 0);
}
