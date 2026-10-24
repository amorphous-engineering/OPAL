import type {
	Attachment,
	Issue,
	Procedure,
	ProcedureKitItem,
	ProcedureOutput,
	ProcedureVersion
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
}
