/** The completed-execution report, the holds payload and the QR code. */
import { type ExecutionReport, OpalError, now } from '@opal/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { Ctx } from '../../context.ts';
import { attachment, dataPoint, dataset, issue, part, project } from '../../db/schema/index.ts';
import { holdingIssues } from '../issues/holds.ts';
import { captureDisplay } from './document.ts';
import { productionRows } from './material.ts';
import { loadModel, opRowOf } from './model.ts';
import { signoffRecords, userNames } from './present.ts';

export function buildReport(ctx: Pick<Ctx, 'db'>, executionId: number): ExecutionReport {
	const db = ctx.db;
	const m = loadModel(db, executionId);
	if (m.exec.status !== 'completed') {
		throw new OpalError(
			409,
			'not_completed',
			`Work order is ${m.exec.status.toUpperCase().replace('_', ' ')}; reports are only generated for COMPLETED work orders`
		);
	}
	const ids = m.rows.map((r) => r.id);
	const recs = signoffRecords(db, ids);
	const names = userNames(db, [
		m.exec.createdById,
		...m.rows.map((r) => r.se.completedById),
		...[...recs.values()].flat().map((s) => s.signedById)
	]);
	const nm = (id: number | null) => (id === null ? null : (names.get(id) ?? null));

	const operations = m.rows.map((r) => ({
		stepNumber: r.number,
		level: r.level,
		title: r.title || '(untitled)',
		status: r.se.status,
		startedAt: r.se.startedAt,
		completedAt: r.se.completedAt,
		operator: nm(r.se.completedById),
		signoffs: (recs.get(r.id) ?? []).map((s) => ({
			slot: s.slot,
			label: s.label,
			role: s.role,
			signedBy: nm(s.signedById),
			signedAt: s.signedAt
		}))
	}));

	const dataCollects = m.rows.flatMap((r) => {
		if (!r.se.dataCaptured || r.se.status === 'skipped') return [];
		const defs = new Map((r.dataSchema?.fields ?? []).map((f) => [f.name, f]));
		const rows = Object.entries(r.se.dataCaptured).map(([name, value]) => ({
			label: defs.get(name)?.label || name,
			value: captureDisplay(value),
			unit: defs.get(name)?.unit ?? null
		}));
		return rows.length ? [{ stepNumber: r.number, stepTitle: r.title || '(untitled)', rows }] : [];
	});

	// Datasets with chart-enabled numeric fields whose points tie to this execution.
	const chartDatasets: ExecutionReport['chartDatasets'] = [];
	if (ids.length) {
		const points = db.select().from(dataPoint).where(inArray(dataPoint.stepExecutionId, ids)).orderBy(asc(dataPoint.recordedAt)).all();
		const byDs = new Map<number, typeof points>();
		for (const p of points) byDs.set(p.datasetId, [...(byDs.get(p.datasetId) ?? []), p]);
		if (byDs.size) {
			for (const ds of db.select().from(dataset).where(inArray(dataset.id, [...byDs.keys()])).all()) {
				const fields = ds.schema.fields ?? [];
				const chartFields = fields.filter((f) => f.chart === true && f.type === 'number');
				if (!chartFields.length) continue;
				const pick = (f: (typeof fields)[number]) => ({ name: f.name, ...(f.unit ? { unit: f.unit } : {}) });
				chartDatasets.push({
					datasetId: ds.id,
					name: ds.name,
					chartFields: chartFields.map(pick),
					fields: fields.map(pick),
					points: byDs.get(ds.id)!.map((p) => ({ recordedAt: p.recordedAt, values: p.values as Record<string, unknown> }))
				});
			}
		}
	}

	const issues = db.select().from(issue).where(eq(issue.executionId, executionId)).orderBy(asc(issue.createdAt), asc(issue.id)).all();
	const closeout = db
		.select()
		.from(attachment)
		.where(and(eq(attachment.ownerType, 'execution'), eq(attachment.ownerId, executionId), eq(attachment.kind, 'closeout')))
		.orderBy(asc(attachment.createdAt))
		.all();

	let endItems: ExecutionReport['endItems'] = productionRows(db, m).map((p) => ({
		partId: p.partId,
		partName: p.partName,
		partNumber: p.partNumber,
		opalNumber: p.opalNumber,
		serialNumber: p.serialNumber,
		quantity: p.quantity,
		status: p.status
	}));
	if (!endItems.length && m.snapshot.outputs.length) {
		const parts = new Map(db.select().from(part).where(inArray(part.id, m.snapshot.outputs.map((o) => o.partId))).all().map((p) => [p.id, p]));
		endItems = m.snapshot.outputs.map((o) => ({
			partId: o.partId,
			partName: parts.get(o.partId)?.name ?? '',
			partNumber: parts.get(o.partId)?.internalPn ?? '',
			opalNumber: null,
			serialNumber: null,
			quantity: o.quantity,
			status: 'planned'
		}));
	}

	return {
		execution: {
			id: m.exec.id,
			woNumber: m.exec.woNumber,
			status: m.exec.status,
			projectCode: db.select().from(project).where(eq(project.id, m.exec.projectId)).get()?.code ?? '',
			procedureId: m.exec.procedureId,
			procedureName: m.snapshot.procedure.name,
			versionNumber: m.version.versionNumber,
			operator: nm(m.exec.createdById),
			startedAt: m.exec.startedAt,
			completedAt: m.exec.completedAt
		},
		generatedAt: now(),
		endItems,
		operations,
		dataCollects,
		chartDatasets,
		issues: issues.map((i) => ({
			id: i.id,
			issueNumber: i.issueNumber,
			issueType: i.issueType,
			priority: i.priority,
			status: i.status,
			title: i.title,
			rootCause: i.rootCause,
			dispositionType: i.dispositionType,
			createdAt: i.createdAt
		})),
		closeoutAttachments: closeout.map((a) => ({ id: a.id, filename: a.filename, createdAt: a.createdAt }))
	};
}

/** What each undispositioned issue stops, as labels like `OP 4 COMPLETE`. */
export function holdsPayload(ctx: Pick<Ctx, 'db'>, executionId: number) {
	const m = loadModel(ctx.db, executionId);
	const holds = holdingIssues(ctx.db, executionId).map((i) => {
		const anchor =
			(i.containmentStepId !== null ? m.byId.get(i.containmentStepId) : undefined) ??
			(i.raisedStepId !== null ? m.byId.get(i.raisedStepId) : undefined);
		const wo = m.exec.woNumber;
		let blocks: string[];
		if (i.containment === 'wo' || !anchor) blocks = [`${wo} COMPLETE`];
		else {
			const op = opRowOf(m, anchor);
			const scope = (r: typeof anchor) => (r.level === 0 ? `OP ${r.number}` : r.number);
			if (i.containment === 'op') blocks = [`${scope(op)} COMPLETE`];
			else if (i.containmentStepId !== null && i.raisedStepId !== null && i.containmentStepId !== i.raisedStepId) blocks = [`${scope(anchor)} COMPLETE`];
			else blocks = op.id !== anchor.id ? [`${scope(anchor)} COMPLETE`, `${scope(op)} COMPLETE`] : [`${scope(anchor)} COMPLETE`];
		}
		return {
			issueId: i.id,
			issueNumber: i.issueNumber,
			title: i.title,
			priority: i.priority,
			containment: i.containment,
			ticketState: i.ticketState,
			raisedStepId: i.raisedStepId,
			containmentStepId: i.containmentStepId,
			blocks
		};
	});
	return { executionId, held: holds.length > 0, holds };
}

export async function qrSvg(ctx: Pick<Ctx, 'db'>, id: number, origin?: string): Promise<string> {
	loadModel(ctx.db, id);
	let base = '';
	if (origin) {
		if (!/^https?:\/\//.test(origin)) throw new OpalError(422, 'invalid_input', 'origin must be an http(s) origin', { origin: 'Not an http(s) origin' });
		base = origin.replace(/\/+$/, '');
	}
	return QRCode.toString(`${base}/executions/${id}`, { type: 'svg', margin: 1 });
}

