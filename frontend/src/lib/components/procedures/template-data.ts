import type {
	ExecutionRow,
	IssueRow,
	KitLine,
	OutputLine,
	ProcedureDetail,
	RefDoc,
	VersionRow
} from './types.js';
import type { Page } from '#lib/api.js';

/** What the template page loads, as the template components receive it. */
export interface TemplateData {
	procedure: ProcedureDetail;
	versions: VersionRow[];
	kit: KitLine[];
	outputs: OutputLine[];
	executions: Page<ExecutionRow>;
	issues: Page<IssueRow>;
	docs: RefDoc[];
}
