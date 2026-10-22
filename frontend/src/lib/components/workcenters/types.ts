export interface Workcenter {
	id: number;
	name: string;
	code: string;
	description: string | null;
	location: string | null;
	is_active: boolean;
	default_step_count: number;
	queued_step_count: number;
}

export interface DefaultStep {
	procedure_id: number;
	procedure_name: string;
	procedure_status: string;
	step_number: string;
	title: string;
}

export interface QueuedStep {
	instance_id: number;
	work_order_number: string | null;
	procedure_id: number;
	procedure_name: string;
	instance_status: string;
	priority: number;
	target_completion_at: string | null;
	step_number_str: string;
	step_title: string | null;
	step_status: string;
}

export interface WorkcenterWork {
	default_steps: DefaultStep[];
	queue: QueuedStep[];
}

export interface WorkcenterInput {
	code: string;
	name: string;
	location: string | null;
	description: string | null;
	is_active: boolean;
}
