/** Publishing and reading versions: publish, list, get, diff, restore, QR. */
import {
	type Procedure,
	type ProcedureSnapshot,
	type ProcedureVersion,
	type ProcedureVersionDetail,
	type VersionDiff,
	type VersionPart,
	conflict,
	notFound
} from '@opal/shared';
import { desc, eq, inArray, like, max } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { Ctx } from '../../context.ts';
import { actorUserId } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	attachment,
	kitItem,
	part,
	procedure,
	procedureOutput,
	procedureStep,
	procedureVersion,
	project,
	stepDependency,
	stepImage,
	user,
	workcenter
} from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { ensurePartsActive } from '../parts/lifecycle.ts';
import { getBlob } from '../platform/attachments.ts';
import { diffPartLists, diffProcedure, diffSteps } from './diff.ts';
import { presentProcedure } from './index.ts';
import { procedureRow, stepRows } from './draft.ts';
import { buildSnapshot } from './snapshot.ts';
import { removeStepDeep, invalid } from './steps.ts';
import { layoutAll } from './tree.ts';
import { parseQty } from '@opal/shared';

type VersionRow = typeof procedureVersion.$inferSelect;

function versionRow(db: Db, id: number): VersionRow {
	const row = db.select().from(procedureVersion).where(eq(procedureVersion.id, id)).get();
	if (!row) throw notFound('Version');
	return row;
}

export function presentVersion(db: Db, row: VersionRow, currentVersionId?: number | null): ProcedureVersion {
	const current = currentVersionId === undefined ? procedureRow(db, row.procedureId).currentVersionId : currentVersionId;
	const author = row.createdById == null ? null : db.select({ name: user.name }).from(user).where(eq(user.id, row.createdById)).get();
	return {
		id: row.id,
		procedureId: row.procedureId,
		versionNumber: row.versionNumber,
		createdAt: row.createdAt,
		createdById: row.createdById,
		createdByName: author?.name ?? null,
		changeNote: row.changeNote,
		stepCount: row.content.steps.length,
		isCurrent: current === row.id
	};
}

/** Every part id a snapshot names. */
export function snapshotPartIds(s: ProcedureSnapshot): number[] {
	return [
		...new Set([
			...s.kit.map((k) => k.partId),
			...s.outputs.map((o) => o.partId),
			...s.steps.flatMap((x) => x.kit.map((k) => k.partId))
		])
	].sort((a, b) => a - b);
}

// ------------------------------------------------------------------- publish

export function publish(ctx: Ctx, procedureId: number, changeNote?: string | null): ProcedureVersion {
	const proc = procedureRow(ctx.db, procedureId);
	if (!stepRows(ctx.db, procedureId).length) {
		throw conflict('empty_procedure', 'Cannot publish a procedure with no steps');
	}
	const snapshot = buildSnapshot(ctx, procedureId);
	// Publishing is the commitment: the kit and outputs must not hold draft parts.
	ensurePartsActive(ctx, snapshotPartIds(snapshot), `publish of procedure ${proc.templateNumber}`);
	const last = ctx.db
		.select({ n: max(procedureVersion.versionNumber) })
		.from(procedureVersion)
		.where(eq(procedureVersion.procedureId, procedureId))
		.get();
	const version = insert(ctx, procedureVersion, {
		procedureId,
		versionNumber: (last?.n ?? 0) + 1,
		content: snapshot,
		changeNote: changeNote?.trim() || null,
		createdById: actorUserId(ctx.actor)
	});
	update(ctx, procedure, procedureId, { currentVersionId: version.id, status: 'released' });
	return presentVersion(ctx.db, version, version.id);
}

// ------------------------------------------------------------------- read

export function listVersions(ctx: Ctx, procedureId: number): ProcedureVersion[] {
	const proc = procedureRow(ctx.db, procedureId);
	return ctx.db
		.select()
		.from(procedureVersion)
		.where(eq(procedureVersion.procedureId, procedureId))
		.orderBy(desc(procedureVersion.versionNumber))
		.all()
		.map((v) => presentVersion(ctx.db, v, proc.currentVersionId));
}

export function partsOf(db: Db, ids: number[]): VersionPart[] {
	if (!ids.length) return [];
	return db
		.select()
		.from(part)
		.where(inArray(part.id, ids))
		.orderBy(part.internalPn)
		.all()
		.map((p) => ({
			id: p.id,
			internalPn: p.internalPn,
			name: p.name,
			externalPn: p.externalPn,
			unitOfMeasure: p.unitOfMeasure,
			state: p.state
		}));
}

export function getVersion(ctx: Ctx, versionId: number): ProcedureVersionDetail {
	const row = versionRow(ctx.db, versionId);
	const proc = procedureRow(ctx.db, row.procedureId);
	return {
		...presentVersion(ctx.db, row, proc.currentVersionId),
		procedureTemplateNumber: proc.templateNumber,
		procedureName: proc.name,
		procedureType: proc.procedureType,
		procedureStatus: proc.status,
		projectCode: ctx.db.select({ code: project.code }).from(project).where(eq(project.id, row.content.procedure.projectId)).get()?.code ?? '',
		snapshot: row.content,
		parts: partsOf(ctx.db, snapshotPartIds(row.content))
	};
}

export async function versionQr(ctx: Ctx, versionId: number, url: string): Promise<string> {
	versionRow(ctx.db, versionId);
	return QRCode.toString(url, { type: 'svg', margin: 1 });
}

/**
 * For the execution area: the version a new execution runs. Default: the current version.
 * Refused when the procedure is obsolete or has nothing published.
 */
export function versionForExecution(ctx: Pick<Ctx, 'db'>, procedureId: number, versionId?: number): VersionRow {
	const proc = procedureRow(ctx.db, procedureId);
	if (proc.status === 'obsolete') throw conflict('procedure_obsolete', `${proc.templateNumber} is obsolete`);
	const id = versionId ?? proc.currentVersionId;
	if (id == null) throw conflict('not_published', `${proc.templateNumber} has no published version`);
	const row = versionRow(ctx.db, id);
	if (row.procedureId !== procedureId) throw notFound('Version');
	return row;
}

/** For `purgeOrphanBlobs`: does any published version hold this hash? */
export function versionHoldsBlob(db: Db): (sha256: string) => boolean {
	return (sha256) =>
		!!db
			.select({ id: procedureVersion.id })
			.from(procedureVersion)
			.where(like(procedureVersion.content as never, `%${sha256}%`))
			.get();
}

// ------------------------------------------------------------------- diff

export function diffVersions(ctx: Ctx, procedureId: number, aId: number, bId: number): VersionDiff {
	const proc = procedureRow(ctx.db, procedureId);
	const rows = ctx.db
		.select()
		.from(procedureVersion)
		.where(inArray(procedureVersion.id, [aId, bId]))
		.all()
		.filter((v) => v.procedureId === procedureId);
	const va = rows.find((v) => v.id === aId);
	const vb = rows.find((v) => v.id === bId);
	if (!va || !vb) throw notFound('Version for this procedure');
	const a = va.content;
	const b = vb.content;
	const steps = diffSteps(a, b);
	const kit = diffPartLists(a.kit, b.kit);
	const outputs = diffPartLists(a.outputs, b.outputs);
	const names = new Map(partsOf(ctx.db, [...new Set([...kit, ...outputs].map((d) => d.partId))]).map((p) => [p.id, p]));
	const named = (rowsIn: typeof kit) =>
		rowsIn.map((d) => ({ ...d, internalPn: names.get(d.partId)?.internalPn ?? null, name: names.get(d.partId)?.name ?? null }));
	const count = (s: string) => steps.filter((d) => d.status === s).length;
	return {
		procedureId,
		procedureName: proc.name,
		versionA: presentVersion(ctx.db, va, proc.currentVersionId),
		versionB: presentVersion(ctx.db, vb, proc.currentVersionId),
		procedureChanges: diffProcedure(a, b),
		steps,
		kit: named(kit),
		outputs: named(outputs),
		added: count('added'),
		removed: count('removed'),
		modified: count('modified'),
		unchanged: count('unchanged')
	};
}

// ------------------------------------------------------------------- restore

/**
 * Replace the draft steps, kit and outputs with a version's snapshot. Step ids come back as they
 * were, so one id keeps naming one step across versions. The status and the current version stay.
 */
export function restoreVersion(ctx: Ctx, procedureId: number, versionId: number): Procedure {
	procedureRow(ctx.db, procedureId);
	const row = versionRow(ctx.db, versionId);
	if (row.procedureId !== procedureId) throw notFound('Version for this procedure');
	const snap = row.content;
	if (snap.schemaVersion !== 1) throw invalid('unsupported_snapshot', 'This version has an unsupported snapshot format');

	const all = stepRows(ctx.db, procedureId);
	for (const s of all.filter((x) => x.parentStepId === null)) removeStepDeep(ctx, s, all);
	for (const k of ctx.db.select().from(kitItem).where(eq(kitItem.procedureId, procedureId)).all()) remove(ctx, kitItem, k.id);
	for (const o of ctx.db.select().from(procedureOutput).where(eq(procedureOutput.procedureId, procedureId)).all()) {
		remove(ctx, procedureOutput, o.id);
	}

	const wcs = new Set(ctx.db.select({ id: workcenter.id }).from(workcenter).all().map((w) => w.id));
	const place = new Map(
		layoutAll(snap.steps.map((s) => ({ id: s.id, parentStepId: s.parentId, isContingency: s.isContingency && s.parentId === null, position: s.order }))).map((p) => [p.id, p])
	);
	for (const s of snap.steps) {
		const at = place.get(s.id)!;
		insert(ctx, procedureStep, {
			id: s.id,
			procedureId,
			parentStepId: s.parentId,
			isContingency: at.isContingency,
			position: at.position,
			title: s.title,
			instructions: s.instructions,
			dataSchema: s.dataSchema,
			signoffs: s.signoffs.map((x) => ({ role: x.role })),
			estimatedDurationMinutes: s.estimatedDurationMinutes,
			callouts: s.callouts.map((c) => ({ ...c })),
			strictSequence: s.strictSequence,
			workcenterId: s.workcenterId !== null && wcs.has(s.workcenterId) ? s.workcenterId : null
		});
		s.images.forEach((img, position) => {
			if (!getBlob(ctx.db, img.sha256)) return;
			const att = insert(ctx, attachment, {
				blobSha256: img.sha256,
				filename: img.filename,
				ownerType: 'procedure_step',
				ownerId: s.id,
				kind: 'step_image',
				note: null,
				uploadedById: actorUserId(ctx.actor)
			});
			insert(ctx, stepImage, { stepId: s.id, attachmentId: att.id, caption: img.caption, position });
		});
		for (const k of s.kit) {
			insert(ctx, kitItem, { stepId: s.id, partId: k.partId, quantity: parseQty(k.quantity), usage: k.usage, notes: k.notes });
		}
	}
	for (const s of snap.steps) {
		for (const dep of s.dependsOn) insert(ctx, stepDependency, { stepId: s.id, dependsOnStepId: dep });
	}
	for (const k of snap.kit) {
		insert(ctx, kitItem, { procedureId, stepId: null, partId: k.partId, quantity: parseQty(k.quantity), usage: 'consume', notes: null });
	}
	for (const o of snap.outputs) {
		insert(ctx, procedureOutput, { procedureId, partId: o.partId, quantity: parseQty(o.quantity) });
	}
	return presentProcedure(ctx, procedureRow(ctx.db, procedureId));
}
