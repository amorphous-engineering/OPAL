import type {
	Attachment,
	Issue,
	Procedure,
	ProcedureKitItem,
	ProcedureOutput,
	ProcedureStep,
	ProcedureVersion,
	ProcedureVersionDetail
} from '@opal/shared';
import type { ExecutionRow } from './types.js';

/** What the template page loads, as the template components receive it. */
export interface TemplateData {
	procedure: Procedure;
	versions: ProcedureVersion[];
	kit: ProcedureKitItem[];
	outputs: ProcedureOutput[];
	executions: { items: ExecutionRow[]; total: number };
	issues: { items: Issue[]; total: number };
	docs: Attachment[];
	/** The released version, which is what the floor works from. Null until one is published. */
	current: ProcedureVersionDetail | null;
	/** The draft's steps, loaded only when no version exists to read instead. */
	draftSteps: ProcedureStep[] | null;
}
