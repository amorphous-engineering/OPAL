/**
 * Legacy assembly structure -> `bom_line` rows, for the import.
 *
 * The legacy database had two homes for structure: `part.parent_id` (a child belongs to one
 * parent assembly) and `bom_lines` (assembly, component, integer quantity). The new schema has
 * only `bom_line`:
 *
 * 1. Every legacy `bom_lines` row becomes a line; the integer quantity is scaled to Qty.
 * 2. Every `part.parent_id` becomes a line (parent = assembly, child = component, quantity 1)
 *    unless a line for the same pair exists from step 1; that line keeps its quantity.
 * 3. A line that would close a loop, point at a missing part, or repeat a pair is dropped and
 *    reported. Soft-deleted parts keep their lines (they import as `obsolete`).
 */
import { QTY_SCALE } from '@opal/shared';

export interface LegacyBomRow {
	id: number;
	assemblyId: number;
	componentId: number;
	quantity: number;
	referenceDesignator: string | null;
	notes: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface BomLineInsert {
	assemblyId: number;
	componentId: number;
	/** Qty units. */
	quantity: number;
	referenceDesignator: string | null;
	notes: string | null;
	createdAt: string;
	updatedAt: string;
}

export function mergeLegacyBom(
	partIds: Set<number>,
	parents: { id: number; parentId: number | null; createdAt: string; updatedAt: string }[],
	bomRows: LegacyBomRow[]
): { lines: BomLineInsert[]; warnings: string[] } {
	const lines: BomLineInsert[] = [];
	const warnings: string[] = [];
	const pairs = new Set<string>();
	const children = new Map<number, Set<number>>();

	const reaches = (from: number, target: number): boolean => {
		const seen = new Set<number>();
		const stack = [from];
		while (stack.length) {
			const id = stack.pop()!;
			if (id === target) return true;
			if (seen.has(id)) continue;
			seen.add(id);
			for (const c of children.get(id) ?? []) stack.push(c);
		}
		return false;
	};

	const add = (line: BomLineInsert, source: string) => {
		const key = `${line.assemblyId}>${line.componentId}`;
		if (!partIds.has(line.assemblyId) || !partIds.has(line.componentId)) {
			return warnings.push(`${source}: part missing, line dropped (${key})`);
		}
		if (line.assemblyId === line.componentId) return warnings.push(`${source}: part contains itself, line dropped (${key})`);
		if (pairs.has(key)) return warnings.push(`${source}: duplicate of an earlier line, dropped (${key})`);
		if (reaches(line.componentId, line.assemblyId)) return warnings.push(`${source}: would close a loop, dropped (${key})`);
		pairs.add(key);
		children.set(line.assemblyId, (children.get(line.assemblyId) ?? new Set()).add(line.componentId));
		lines.push(line);
	};

	for (const r of bomRows) {
		add(
			{
				assemblyId: r.assemblyId,
				componentId: r.componentId,
				quantity: Math.max(1, Math.round(r.quantity * QTY_SCALE)),
				referenceDesignator: r.referenceDesignator,
				notes: r.notes,
				createdAt: r.createdAt,
				updatedAt: r.updatedAt
			},
			`bom_lines ${r.id}`
		);
	}
	for (const p of parents) {
		if (p.parentId === null) continue;
		const key = `${p.parentId}>${p.id}`;
		if (pairs.has(key)) continue; // the bom_lines row wins and keeps its quantity
		add(
			{
				assemblyId: p.parentId,
				componentId: p.id,
				quantity: QTY_SCALE,
				referenceDesignator: null,
				notes: null,
				createdAt: p.createdAt,
				updatedAt: p.updatedAt
			},
			`part ${p.id} parent_id`
		);
	}
	return { lines, warnings };
}
