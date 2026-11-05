/** Types of the procedures screens: the contract types, plus the groupings the screens draw. */
import type { ProcedureStep, SnapshotStep, VersionPart } from '@opal/shared';

export type {
	PartDiff,
	Procedure,
	ProcedureDataField as DataField,
	ProcedureKitItem as KitLine,
	ProcedureOutput as OutputLine,
	ProcedureStatus,
	ProcedureStep,
	ProcedureType,
	ProcedureVersion as VersionRow,
	ProcedureVersionDetail as VersionDetail,
	SnapshotStep,
	StepDiff,
	VersionDiff
} from '@opal/shared';

export interface OpGroup {
	op: SnapshotStep;
	subs: SnapshotStep[];
}

/** Group a flat snapshot into ops (normal first, then contingency) with their sub-steps. */
export function groupOps(steps: SnapshotStep[]): { ops: OpGroup[]; contingency: OpGroup[] } {
	const byOrder = (a: SnapshotStep, b: SnapshotStep) => a.order - b.order;
	const children = new Map<number, SnapshotStep[]>();
	for (const s of steps) {
		if (s.parentId != null) {
			const list = children.get(s.parentId) ?? [];
			list.push(s);
			children.set(s.parentId, list);
		}
	}
	const groups = steps
		.filter((s) => s.parentId == null)
		.sort(byOrder)
		.map((op) => ({ op, subs: (children.get(op.id) ?? []).sort(byOrder) }));
	return {
		ops: groups.filter((g) => !g.op.isContingency),
		contingency: groups.filter((g) => g.op.isContingency)
	};
}

/** The procedure status as the screens name it. */
export const PROCEDURE_STATUS_OPTIONS = [
	{ value: 'draft', label: 'DRAFT' },
	{ value: 'released', label: 'RELEASED' },
	{ value: 'obsolete', label: 'OBSOLETE' }
] as const;

/**
 * A row of the executions list. The execution area owns this shape; the template page
 * shows the few fields below and tolerates an absent list.
 */
export interface ExecutionRow {
	id: number;
	workOrderNumber: string | null;
	versionNumber: number;
	status: string;
}

/**
 * The draft in the shape of a snapshot, so one reader shows both: a published version, or the
 * draft of a template that was never published. Parts come from the kit lines themselves.
 */
export function draftAsSnapshot(steps: ProcedureStep[]): {
	steps: SnapshotStep[];
	parts: VersionPart[];
} {
	const parts = new Map<number, VersionPart>();
	const out = steps.map((s) => {
		for (const k of s.kit) {
			parts.set(k.partId, {
				id: k.partId,
				internalPn: k.partNumber,
				name: k.partName,
				externalPn: k.partExternalPn,
				unitOfMeasure: k.unitOfMeasure,
				state: k.partState
			});
		}
		return {
			id: s.id,
			order: s.order,
			number: s.number,
			level: s.level,
			parentId: s.parentId,
			title: s.title,
			instructions: s.instructions,
			dataSchema: s.dataSchema,
			isContingency: s.isContingency,
			strictSequence: s.strictSequence,
			estimatedDurationMinutes: s.estimatedDurationMinutes,
			workcenterId: s.workcenterId,
			signoffs: s.signoffs,
			callouts: s.callouts,
			dependsOn: s.dependsOn,
			images: s.images.map((i) => ({ sha256: i.sha256, filename: i.filename, caption: i.caption })),
			kit: s.kit.map((k) => ({
				partId: k.partId,
				quantity: k.quantity,
				usage: k.usage,
				notes: k.notes
			}))
		} satisfies SnapshotStep;
	});
	return { steps: out, parts: [...parts.values()] };
}

/** Nodes and edges of the OP dependency graph of a snapshot. */
export function snapshotGraph(steps: SnapshotStep[]) {
	const { ops, contingency } = groupOps(steps);
	const all = [...ops, ...contingency];
	const ids = new Set(all.map((g) => g.op.id));
	return {
		nodes: all.map((g) => ({
			id: g.op.id,
			number: g.op.number,
			title: g.op.title,
			kind: g.op.isContingency ? ('contingency' as const) : ('op' as const)
		})),
		edges: all.flatMap((g) =>
			g.op.dependsOn
				.filter((d) => ids.has(d))
				.map((d) => ({ from: d, to: g.op.id, kind: 'dependency' as const }))
		)
	};
}
