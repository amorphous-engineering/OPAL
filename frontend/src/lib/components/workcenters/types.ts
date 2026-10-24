import type { Workcenter, WorkcenterWork } from '@opal/shared';

export type { Workcenter, WorkcenterWork };

export interface WorkcenterInput {
	code: string;
	name: string;
	location: string | null;
	description: string | null;
	isActive: boolean;
}
