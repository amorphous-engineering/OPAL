/**
 * Reading the draft: loaders and the presenters that turn rows into the wire shapes
 * (ProcedureStep, ProcedureKitItem, ProcedureOutput). Writers live in the sibling files.
 */
import {
	type ProcedureKitItem,
	type ProcedureOutput,
	type ProcedureStep,
	type ProcedureStepImage,
	type Qty,
	formatQty,
	notFound
} from '@opal/shared';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	attachment,
	blob,
	kitItem,
	part,
	procedure,
	procedureOutput,
	procedureStep,
	stepDependency,
	stepImage
} from '../../db/schema/index.ts';
import { onHandByPart } from '../inventory/ledger.ts';
import { deriveFlags, effectiveSignoffs } from './signoffs.ts';
import { documentOrder, numbering } from './tree.ts';

export type ProcedureRow = typeof procedure.$inferSelect;
export type StepRow = typeof procedureStep.$inferSelect;

export function procedureRow(db: Db, id: number): ProcedureRow {
	const row = db.select().from(procedure).where(eq(procedure.id, id)).get();
	if (!row) throw notFound('Procedure');
	return row;
}

export function stepRows(db: Db, procedureId: number): StepRow[] {
	return db.select().from(procedureStep).where(eq(procedureStep.procedureId, procedureId)).all();
}

export function stepRow(db: Db, procedureId: number, stepId: number): StepRow {
	const row = db
		.select()
		.from(procedureStep)
		.where(and(eq(procedureStep.id, stepId), eq(procedureStep.procedureId, procedureId)))
		.get();
	if (!row) throw notFound('Step');
	return row;
}

// ------------------------------------------------------------------- kit

type KitRow = typeof kitItem.$inferSelect;

export function presentKit(ctx: Pick<Ctx, 'db'>, rows: KitRow[]): ProcedureKitItem[] {
	if (!rows.length) return [];
	const ids = [...new Set(rows.map((r) => r.partId))];
	const parts = new Map(ctx.db.select().from(part).where(inArray(part.id, ids)).all().map((p) => [p.id, p]));
	const onHand = onHandByPart(ctx, ids);
	return rows.map((r) => {
		const p = parts.get(r.partId)!;
		return {
			id: r.id,
			procedureId: r.procedureId ?? stepProcedure(ctx.db, r.stepId!),
			stepId: r.stepId,
			partId: r.partId,
			partNumber: p.internalPn,
			partName: p.name,
			partExternalPn: p.externalPn,
			partState: p.state,
			unitOfMeasure: p.unitOfMeasure,
			quantity: formatQty(r.quantity as Qty),
			usage: r.usage,
			notes: r.notes,
			onHand: formatQty(onHand.get(r.partId) ?? (0 as Qty))
		};
	});
}

function stepProcedure(db: Db, stepId: number): number {
	return db.select({ p: procedureStep.procedureId }).from(procedureStep).where(eq(procedureStep.id, stepId)).get()!.p;
}

export function procedureKitRows(db: Db, procedureId: number): KitRow[] {
	return db
		.select()
		.from(kitItem)
		.where(and(eq(kitItem.procedureId, procedureId), isNull(kitItem.stepId)))
		.orderBy(asc(kitItem.id))
		.all();
}

export function presentOutputs(ctx: Pick<Ctx, 'db'>, procedureId: number): ProcedureOutput[] {
	const rows = ctx.db.select().from(procedureOutput).where(eq(procedureOutput.procedureId, procedureId)).orderBy(asc(procedureOutput.id)).all();
	return rows.map((r) => presentOutput(ctx, r));
}

export function presentOutput(ctx: Pick<Ctx, 'db'>, r: typeof procedureOutput.$inferSelect): ProcedureOutput {
	const p = ctx.db.select().from(part).where(eq(part.id, r.partId)).get()!;
	return {
		id: r.id,
		procedureId: r.procedureId,
		partId: r.partId,
		partNumber: p.internalPn,
		partName: p.name,
		partExternalPn: p.externalPn,
		partState: p.state,
		unitOfMeasure: p.unitOfMeasure,
		quantity: formatQty(r.quantity as Qty)
	};
}

// ------------------------------------------------------------------- images

export function imageRows(db: Db, stepIds: number[]) {
	if (!stepIds.length) return [];
	return db
		.select({
			id: stepImage.id,
			stepId: stepImage.stepId,
			attachmentId: stepImage.attachmentId,
			sha256: attachment.blobSha256,
			filename: attachment.filename,
			mimeType: blob.mimeType,
			caption: stepImage.caption,
			position: stepImage.position
		})
		.from(stepImage)
		.innerJoin(attachment, eq(attachment.id, stepImage.attachmentId))
		.innerJoin(blob, eq(blob.sha256, attachment.blobSha256))
		.where(inArray(stepImage.stepId, stepIds))
		.orderBy(asc(stepImage.position), asc(stepImage.id))
		.all();
}

export function presentImages(db: Db, stepId: number): ProcedureStepImage[] {
	return imageRows(db, [stepId]).map(({ stepId: _s, mimeType: _m, ...img }) => img);
}

// ------------------------------------------------------------------- steps

/** Prerequisite edges of the given steps: step id to the ids it waits on. */
export function dependencyMap(db: Db, stepIds: number[]): Map<number, number[]> {
	const out = new Map<number, number[]>();
	if (!stepIds.length) return out;
	const rows = db
		.select()
		.from(stepDependency)
		.where(inArray(stepDependency.stepId, stepIds))
		.orderBy(asc(stepDependency.id))
		.all();
	for (const d of rows) out.set(d.stepId, [...(out.get(d.stepId) ?? []), d.dependsOnStepId]);
	for (const list of out.values()) list.sort((a, b) => a - b);
	return out;
}

/** All draft steps in document order with images, kit lines and dependencies. */
export function presentDraft(ctx: Pick<Ctx, 'db'>, procedureId: number): ProcedureStep[] {
	const rows = stepRows(ctx.db, procedureId);
	const ordered = documentOrder(rows);
	const nums = numbering(rows);
	const ids = ordered.map((s) => s.id);
	const hasKids = new Set(rows.map((r) => r.parentStepId).filter((x): x is number => x !== null));
	const images = new Map<number, ProcedureStepImage[]>();
	for (const { stepId, mimeType: _m, ...img } of imageRows(ctx.db, ids)) {
		images.set(stepId, [...(images.get(stepId) ?? []), img]);
	}
	const kits = ids.length
		? ctx.db.select().from(kitItem).where(and(inArray(kitItem.stepId, ids), isNotNull(kitItem.stepId))).orderBy(asc(kitItem.id)).all()
		: [];
	const kitPresented = presentKit(ctx, kits);
	const kitByStep = new Map<number, ProcedureKitItem[]>();
	for (const k of kitPresented) kitByStep.set(k.stepId!, [...(kitByStep.get(k.stepId!) ?? []), k]);
	const deps = dependencyMap(ctx.db, ids);
	return ordered.map((s) => {
		const n = nums.get(s.id)!;
		const slots = effectiveSignoffs(s.signoffs, hasKids.has(s.id));
		const flags = deriveFlags(slots, hasKids.has(s.id));
		return {
			id: s.id,
			procedureId: s.procedureId,
			order: n.order,
			number: n.number,
			level: n.level,
			parentId: s.parentStepId,
			title: s.title,
			instructions: s.instructions,
			dataSchema: s.dataSchema ?? null,
			isContingency: n.isContingency,
			requiresSignoff: flags.requiresSignoff,
			requiredRole: flags.requiredRole,
			signoffs: slots,
			estimatedDurationMinutes: s.estimatedDurationMinutes,
			callouts: s.callouts ?? [],
			strictSequence: s.strictSequence,
			workcenterId: s.workcenterId,
			dependsOn: deps.get(s.id) ?? [],
			images: images.get(s.id) ?? [],
			kit: kitByStep.get(s.id) ?? []
		};
	});
}

export function presentStep(ctx: Pick<Ctx, 'db'>, procedureId: number, stepId: number): ProcedureStep {
	const found = presentDraft(ctx, procedureId).find((s) => s.id === stepId);
	if (!found) throw notFound('Step');
	return found;
}
