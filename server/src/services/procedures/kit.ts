/**
 * Parts a procedure needs (kit items) and parts it produces (outputs). One `kit_item` table
 * holds both scopes: a row belongs to the procedure or to one step.
 */
import {
	type ProcedureKitItem,
	type ProcedureOutput,
	type Qty,
	conflict,
	notFound,
	parseQty,
	QTY_SCALE
} from '@opal/shared';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { bomLine, kitItem, part, procedureOutput } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { presentKit, presentOutput, presentOutputs, procedureKitRows, procedureRow, stepRow } from './draft.ts';
import { invalid } from './steps.ts';

type Usage = 'consume' | 'tooling';
export type Scope = { procedureId: number; stepId?: undefined } | { procedureId: number; stepId: number };

function positive(quantity: string, field = 'quantity'): Qty {
	const q = parseQty(quantity);
	if (q <= 0) throw invalid('invalid_input', 'Quantity must be above zero', { [field]: 'must be above zero' });
	return q;
}

function requirePart(ctx: Ctx, partId: number) {
	const p = ctx.db.select().from(part).where(eq(part.id, partId)).get();
	if (!p) throw notFound('Part');
	return p;
}

function check(ctx: Ctx, scope: Scope) {
	procedureRow(ctx.db, scope.procedureId);
	if (scope.stepId !== undefined) stepRow(ctx.db, scope.procedureId, scope.stepId);
}

function scopeWhere(scope: Scope) {
	return scope.stepId === undefined
		? and(eq(kitItem.procedureId, scope.procedureId))
		: eq(kitItem.stepId, scope.stepId);
}

function kitRow(ctx: Ctx, scope: Scope, kitId: number) {
	const row = ctx.db.select().from(kitItem).where(and(eq(kitItem.id, kitId), scopeWhere(scope))).get();
	if (!row) throw notFound('Kit item');
	return row;
}

export function listKit(ctx: Ctx, scope: Scope): ProcedureKitItem[] {
	check(ctx, scope);
	const rows =
		scope.stepId === undefined
			? procedureKitRows(ctx.db, scope.procedureId)
			: ctx.db.select().from(kitItem).where(eq(kitItem.stepId, scope.stepId)).orderBy(kitItem.id).all();
	return presentKit(ctx, rows).sort((a, b) => a.partName.localeCompare(b.partName) || a.id - b.id);
}

export function addKit(
	ctx: Ctx,
	scope: Scope,
	input: { partId: number; quantity: string; usage: Usage; notes?: string | null }
): ProcedureKitItem {
	check(ctx, scope);
	requirePart(ctx, input.partId);
	const quantity = positive(input.quantity);
	const dup = ctx.db
		.select({ id: kitItem.id })
		.from(kitItem)
		.where(and(scopeWhere(scope), eq(kitItem.partId, input.partId)))
		.get();
	if (dup) throw conflict('duplicate', scope.stepId === undefined ? 'Part already in kit' : 'Part already in step kit');
	const row = insert(ctx, kitItem, {
		procedureId: scope.stepId === undefined ? scope.procedureId : null,
		stepId: scope.stepId ?? null,
		partId: input.partId,
		quantity,
		usage: input.usage,
		notes: input.notes ?? null
	});
	return presentKit(ctx, [row])[0]!;
}

export function updateKit(
	ctx: Ctx,
	scope: Scope,
	kitId: number,
	input: { quantity?: string; usage?: Usage; notes?: string | null }
): ProcedureKitItem {
	check(ctx, scope);
	kitRow(ctx, scope, kitId);
	const patch: Partial<typeof kitItem.$inferInsert> = {};
	if (input.quantity !== undefined) patch.quantity = positive(input.quantity);
	if (input.usage !== undefined) patch.usage = input.usage;
	if (input.notes !== undefined) patch.notes = input.notes;
	const row = Object.keys(patch).length ? update(ctx, kitItem, kitId, patch) : kitRow(ctx, scope, kitId);
	return presentKit(ctx, [row])[0]!;
}

export function removeKit(ctx: Ctx, scope: Scope, kitId: number): void {
	check(ctx, scope);
	kitRow(ctx, scope, kitId);
	remove(ctx, kitItem, kitId);
}

// ------------------------------------------------------------------- outputs

export function listOutputs(ctx: Ctx, procedureId: number): ProcedureOutput[] {
	procedureRow(ctx.db, procedureId);
	return presentOutputs(ctx, procedureId);
}

/**
 * Add a produced part. Its first-level BOM, times the quantity, joins the procedure kit: a
 * component already in the kit gains the quantity.
 */
export function addOutput(ctx: Ctx, procedureId: number, partId: number, quantity: string): ProcedureOutput {
	procedureRow(ctx.db, procedureId);
	requirePart(ctx, partId);
	const qty = positive(quantity);
	const dup = ctx.db
		.select({ id: procedureOutput.id })
		.from(procedureOutput)
		.where(and(eq(procedureOutput.procedureId, procedureId), eq(procedureOutput.partId, partId)))
		.get();
	if (dup) throw conflict('duplicate', 'Part already in outputs');
	const out = insert(ctx, procedureOutput, { procedureId, partId, quantity: qty });
	for (const line of ctx.db.select().from(bomLine).where(eq(bomLine.assemblyId, partId)).orderBy(bomLine.id).all()) {
		const need = Math.round((line.quantity * qty) / QTY_SCALE);
		if (need <= 0) continue;
		const existing = ctx.db
			.select()
			.from(kitItem)
			.where(and(eq(kitItem.procedureId, procedureId), eq(kitItem.partId, line.componentId)))
			.get();
		if (existing) update(ctx, kitItem, existing.id, { quantity: existing.quantity + need });
		else insert(ctx, kitItem, { procedureId, stepId: null, partId: line.componentId, quantity: need, usage: 'consume', notes: null });
	}
	return presentOutput(ctx, out);
}

function outputRow(ctx: Ctx, procedureId: number, outputId: number) {
	const row = ctx.db
		.select()
		.from(procedureOutput)
		.where(and(eq(procedureOutput.id, outputId), eq(procedureOutput.procedureId, procedureId)))
		.get();
	if (!row) throw notFound('Output item');
	return row;
}

export function updateOutput(ctx: Ctx, procedureId: number, outputId: number, quantity: string): ProcedureOutput {
	procedureRow(ctx.db, procedureId);
	outputRow(ctx, procedureId, outputId);
	return presentOutput(ctx, update(ctx, procedureOutput, outputId, { quantity: positive(quantity) }));
}

export function removeOutput(ctx: Ctx, procedureId: number, outputId: number): void {
	procedureRow(ctx.db, procedureId);
	outputRow(ctx, procedureId, outputId);
	remove(ctx, procedureOutput, outputId);
}
