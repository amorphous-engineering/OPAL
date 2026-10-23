/** Shapes returned by GET /api/procedures/{id}/draft. */
import type { DocSchema } from '#lib/components/procedure-doc/index.js';

export interface DraftKitLine {
	id: number;
	part_id: number;
	part_name: string;
	part_internal_pn: string | null;
	quantity_required: number;
	usage_type: string;
	notes: string | null;
}

export interface DraftImage {
	id: number;
	attachment_id: number;
	caption: string | null;
	position: number;
}

export interface DraftStep {
	id: number;
	order: number;
	step_number: string;
	level: number;
	parent_step_id: number | null;
	title: string;
	instructions: string | null;
	required_data_schema: DocSchema | null;
	is_contingency: boolean;
	requires_signoff: boolean;
	estimated_duration_minutes: number | null;
	required_role: string | null;
	/** The effective sign-off definitions, slot order. */
	signoffs: { label: string; role: string | null }[];
	caution: string | null;
	strict_sequence: boolean;
	workcenter_id: number | null;
	depends_on: number[];
	images: DraftImage[];
	step_kit: DraftKitLine[];
}

export interface DraftResponse {
	procedure_id: number;
	steps: DraftStep[];
}
