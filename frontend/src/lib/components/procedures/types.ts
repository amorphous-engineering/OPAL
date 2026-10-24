/** Types of the procedures screens: the contract types, plus the groupings the screens draw. */
import type { SnapshotStep } from '@opal/shared';

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
