export interface SchemaField {
	name: string;
	type: 'number' | 'text' | 'boolean' | 'date';
	unit?: string;
	chart?: boolean;
}

export interface DatasetSummary {
	id: number;
	name: string;
	description: string | null;
	schema: { fields: SchemaField[] };
	procedure_id: number | null;
	procedure_name: string | null;
	point_count: number;
	created_at: string;
	updated_at: string;
}

export interface DataPointSource {
	instance_id: number;
	work_order_number: string | null;
	step_number_str: string;
	step_title: string | null;
}

export interface DataPoint {
	id: number;
	recorded_at: string;
	values: Record<string, unknown>;
	step_execution_id: number | null;
	source: DataPointSource | null;
}

export interface DatasetDetail extends DatasetSummary {
	data_points: DataPoint[];
}

export interface ProcedureOption {
	id: number;
	name: string;
}
