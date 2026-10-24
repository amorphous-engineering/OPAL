/** Small shared bits of the parts screens. Wire types come from `@opal/shared`. */
import type { Part } from '@opal/shared';

/**
 * A part as the other areas' pages still hold it (snake_case, `lifecycle_state`). The picker
 * emits this shape so pages not yet moved to the typed client keep working; new code reads
 * `Part` from `@opal/shared` through `opal.parts.*`.
 */
export interface PartRef {
	id: number;
	internal_pn: string | null;
	name: string;
}

export interface PickedPart extends PartRef {
	external_pn: string | null;
	category: string | null;
	unit_of_measure: string;
	tracking_type: Part['trackingType'];
	procurement: Part['procurement'];
	tier: number;
	lifecycle_state: Part['state'];
}

export function toPickedPart(p: Part): PickedPart {
	return {
		id: p.id,
		internal_pn: p.internalPn,
		name: p.name,
		external_pn: p.externalPn,
		category: p.category,
		unit_of_measure: p.unitOfMeasure,
		tracking_type: p.trackingType,
		procurement: p.procurement,
		tier: p.tier,
		lifecycle_state: p.state
	};
}

/** pn · name for pickers and links. */
export function partLabel(p: { internal_pn: string | null; name: string }): string {
	return p.internal_pn ? `${p.internal_pn}  ${p.name}` : p.name;
}

export const PARTS_PAGE_SIZE = 50;
