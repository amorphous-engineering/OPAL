// Dataset types come from the shared contracts. Only UI-local shapes live here.
export type { Chart, DataPoint, Dataset, SchemaField } from '@opal/shared';

export interface ProcedureOption {
	id: number;
	name: string;
	projectId?: number; // added by projects
}
