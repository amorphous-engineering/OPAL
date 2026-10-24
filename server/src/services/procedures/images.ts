/**
 * Step reference images. The file is an attachment owned by the step (kind `step_image`), so
 * it lives in the platform blob store. `step_image` holds the caption and display order.
 * Unlinking an image never touches the blob: a published snapshot may hold its hash.
 */
import { type ProcedureStepImage, notFound } from '@opal/shared';
import { and, eq, max } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { attachment, stepImage } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { attach, detach } from '../platform/attachments.ts';
import { presentImages, procedureRow, stepRow } from './draft.ts';
import { invalid } from './steps.ts';

function imageRow(ctx: Ctx, stepId: number, imageId: number) {
	const row = ctx.db
		.select()
		.from(stepImage)
		.where(and(eq(stepImage.id, imageId), eq(stepImage.stepId, stepId)))
		.get();
	if (!row) throw notFound('Step image');
	return row;
}

function one(ctx: Ctx, stepId: number, imageId: number): ProcedureStepImage {
	return presentImages(ctx.db, stepId).find((i) => i.id === imageId)!;
}

export function listImages(ctx: Ctx, procedureId: number, stepId: number): ProcedureStepImage[] {
	procedureRow(ctx.db, procedureId);
	stepRow(ctx.db, procedureId, stepId);
	return presentImages(ctx.db, stepId);
}

export async function addImage(
	ctx: Ctx,
	procedureId: number,
	stepId: number,
	file: { name: string; type: string; bytes: Uint8Array },
	caption?: string | null
): Promise<ProcedureStepImage> {
	procedureRow(ctx.db, procedureId);
	stepRow(ctx.db, procedureId, stepId);
	if (!file.type.toLowerCase().startsWith('image/')) {
		throw invalid('invalid_input', 'Step images must be image files', { file: 'must be an image' });
	}
	const att = await attach(ctx, { type: 'procedure_step', id: stepId }, { ...file, kind: 'step_image' });
	const top = ctx.db.select({ p: max(stepImage.position) }).from(stepImage).where(eq(stepImage.stepId, stepId)).get();
	const row = insert(ctx, stepImage, {
		stepId,
		attachmentId: att.id,
		caption: caption?.trim() || null,
		position: (top?.p ?? -1) + 1
	});
	return one(ctx, stepId, row.id);
}

export function updateImage(
	ctx: Ctx,
	procedureId: number,
	stepId: number,
	imageId: number,
	input: { caption?: string | null }
): ProcedureStepImage {
	procedureRow(ctx.db, procedureId);
	stepRow(ctx.db, procedureId, stepId);
	imageRow(ctx, stepId, imageId);
	if (input.caption !== undefined) update(ctx, stepImage, imageId, { caption: input.caption?.trim() || null });
	return one(ctx, stepId, imageId);
}

export function removeImage(ctx: Ctx, procedureId: number, stepId: number, imageId: number): void {
	procedureRow(ctx.db, procedureId);
	stepRow(ctx.db, procedureId, stepId);
	const row = imageRow(ctx, stepId, imageId);
	remove(ctx, stepImage, row.id);
	if (ctx.db.select({ id: attachment.id }).from(attachment).where(eq(attachment.id, row.attachmentId)).get()) {
		detach(ctx, row.attachmentId);
	}
	// Close the gap in the display order.
	presentImages(ctx.db, stepId).forEach((img, i) => {
		if (img.position !== i) update(ctx, stepImage, img.id, { position: i });
	});
}

export function reorderImages(
	ctx: Ctx,
	procedureId: number,
	stepId: number,
	imageIds: number[]
): ProcedureStepImage[] {
	procedureRow(ctx.db, procedureId);
	stepRow(ctx.db, procedureId, stepId);
	const have = presentImages(ctx.db, stepId);
	if (
		imageIds.length !== have.length ||
		new Set(imageIds).size !== have.length ||
		imageIds.some((i) => !have.some((h) => h.id === i))
	) {
		throw invalid('image_ids_mismatch', "Image ids don't match the step's images");
	}
	imageIds.forEach((imageId, position) => {
		if (have.find((h) => h.id === imageId)!.position !== position) update(ctx, stepImage, imageId, { position });
	});
	return presentImages(ctx.db, stepId);
}
