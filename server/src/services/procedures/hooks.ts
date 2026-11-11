/**
 * What the procedures area registers with other areas, once at module load:
 * part references (a referenced part cannot be deleted), the entity names and search index
 * of the platform, workcenter workload, and undo for the simple writes.
 */
import { conflict } from '@opal/shared';
import { eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import {
	kitItem,
	procedure,
	procedureOutput,
	procedureStep,
	procedureVersion,
	stepDependency,
	stepImage
} from '../../db/schema/index.ts';
import { registerWorkcenterWork } from '../org/workcenters.ts';
import { registerPartReference, registerPublishedKits } from '../parts/references.ts';
import { evidenceFrozen, registerOwnerGuard } from '../platform/attachments.ts';
import { registerEntity, registerReversible, registerSearchable, revertRows } from '../platform/index.ts';
import type { AuditRow } from '../platform/undo.ts';
import { draftRow } from './draft.ts';
import { documentOrder, numbering } from './tree.ts';

registerPartReference({
	name: 'procedure_kit_items',
	count: (ctx, partId) =>
		ctx.db.select({ n: sql<number>`count(*)` }).from(kitItem).where(eq(kitItem.partId, partId)).get()?.n ?? 0
});
registerPartReference({
	name: 'procedure_outputs',
	count: (ctx, partId) =>
		ctx.db.select({ n: sql<number>`count(*)` }).from(procedureOutput).where(eq(procedureOutput.partId, partId)).get()?.n ?? 0
});
// A published version names its parts by id too. A part in a snapshot cannot disappear.
registerPartReference({
	name: 'procedure_versions',
	count: (ctx, partId) =>
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(procedureVersion)
			.where(sql`${procedureVersion.content} LIKE ${`%"partId":${partId},%`} OR ${procedureVersion.content} LIKE ${`%"partId":${partId}}%`}`)
			.get()?.n ?? 0
});

registerPublishedKits((ctx, partId) =>
	ctx.db
		.select({
			procedureId: procedure.id,
			templateNumber: procedure.templateNumber,
			name: procedure.name,
			versionNumber: procedureVersion.versionNumber
		})
		.from(procedureVersion)
		.innerJoin(procedure, eq(procedure.id, procedureVersion.procedureId))
		.where(
			sql`${procedure.status} <> 'obsolete'
				AND ${procedureVersion.versionNumber} = (SELECT max(v.version_number) FROM procedure_version v WHERE v.procedure_id = ${procedure.id})
				AND EXISTS (SELECT 1 FROM json_each(${procedureVersion.content}, '$.outputs') o WHERE json_extract(o.value, '$.partId') = ${partId})`
		)
		.orderBy(procedure.id)
		.all()
);

registerEntity(procedure, {
	label: 'Procedure',
	ref: (r) => ({ label: r.templateNumber, href: `/procedures/${r.id}` })
});
registerEntity(procedureStep, { label: 'Procedure step', parent: { table: procedure, fk: 'procedureId' } });
registerEntity(procedureVersion, { label: 'Procedure version', parent: { table: procedure, fk: 'procedureId' } });
registerEntity(procedureOutput, { label: 'Procedure output', parent: { table: procedure, fk: 'procedureId' } });
registerEntity(kitItem, { label: 'Kit item', parent: { table: procedure, fk: 'procedureId' } });
registerEntity(stepImage, { label: 'Step image', parent: { table: procedureStep, fk: 'stepId' } });
registerEntity(stepDependency, { label: 'Step dependency', parent: { table: procedureStep, fk: 'stepId' } });

registerSearchable({
	type: 'procedure',
	table: procedure,
	columns: [procedure.templateNumber, procedure.name, procedure.description],
	identifier: procedure.templateNumber,
	where: ne(procedure.status, 'obsolete'),
	hit: (r) => ({
		label: r.name,
		sublabel: r.templateNumber,
		href: `/procedures/${r.id}`,
		status: r.status
	})
});

registerWorkcenterWork({
	defaultStepCounts: (db) =>
		new Map(
			db
				.select({ id: procedureStep.workcenterId, n: sql<number>`count(*)` })
				.from(procedureStep)
				.where(isNotNull(procedureStep.workcenterId))
				.groupBy(procedureStep.workcenterId)
				.all()
				.map((r) => [r.id!, r.n])
		),
	queuedCounts: () => new Map(),
	work: (db, workcenterId) => {
		const steps = db.select().from(procedureStep).where(eq(procedureStep.workcenterId, workcenterId)).all();
		if (!steps.length) return { defaultSteps: [] };
		const procs = new Map(db.select().from(procedure).all().map((p) => [p.id, p]));
		const bySteps = new Map<number, typeof steps>();
		for (const s of steps) bySteps.set(s.procedureId, [...(bySteps.get(s.procedureId) ?? []), s]);
		const out: { procedureId: number; procedureName: string; procedureStatus: string; stepNumber: string; title: string }[] = [];
		for (const [pid, mine] of [...bySteps].sort((a, b) => a[0] - b[0])) {
			const all = db.select().from(procedureStep).where(eq(procedureStep.procedureId, pid)).all();
			const nums = numbering(all);
			const p = procs.get(pid)!;
			const wanted = new Set(mine.map((m) => m.id));
			for (const s of documentOrder(all).filter((x) => wanted.has(x.id))) {
				out.push({
					procedureId: pid,
					procedureName: p.name,
					procedureStatus: p.status,
					stepNumber: nums.get(s.id)!.number,
					title: s.title
				});
			}
		}
		return { defaultSteps: out };
	}
});

// Undo is for pencil. A template is pencil until its first version exists; the steps of a
// draft stay pencil for as long as the template can be edited at all.
// A retired template has no EDIT: its reference documents wait for a reinstatement.
const guardTemplateFiles = (ctx: Ctx, id: number) => {
	const p = ctx.db.select().from(procedure).where(eq(procedure.id, id)).get();
	if (p?.status === 'obsolete') throw evidenceFrozen(`${p.templateNumber} is obsolete: reinstate it to change its files`);
};
registerOwnerGuard('procedure', guardTemplateFiles);
// A step image follows its template.
registerOwnerGuard('procedure_step', (ctx, stepId) => {
	const step = ctx.db.select({ procedureId: procedureStep.procedureId }).from(procedureStep).where(eq(procedureStep.id, stepId)).get();
	if (step) guardTemplateFiles(ctx, step.procedureId);
});

function requireNeverPublished(ctx: Ctx, rows: AuditRow[]) {
	for (const r of rows) {
		const p = ctx.db.select().from(procedure).where(eq(procedure.id, r.entityId)).get();
		if (!p) continue;
		if (p.status !== 'draft' || p.currentVersionId !== null) {
			throw conflict('not_pencil', `${p.templateNumber} was published, so this change is on the record`);
		}
	}
}
registerReversible('procedures.create', {
	authorize: requireNeverPublished,
	revert: (ctx, rows) => revertRows(ctx, rows, { procedure })
});
registerReversible('procedures.update', {
	authorize: requireNeverPublished,
	revert: (ctx, rows) => revertRows(ctx, rows, { procedure })
});
registerReversible('procedures.steps.update', {
	authorize: (ctx, rows) => {
		for (const r of rows) {
			const s = ctx.db.select().from(procedureStep).where(eq(procedureStep.id, r.entityId)).get();
			if (!s) continue;
			draftRow(ctx.db, s.procedureId);
		}
	},
	revert: (ctx, rows) => revertRows(ctx, rows, { procedure_step: procedureStep })
});

