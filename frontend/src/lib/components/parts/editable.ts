import type { PartDetail } from '@opal/shared';

/** A part field the part page can edit in place, named as `parts.update` names it. */
export type PartField =
	| 'name'
	| 'tier'
	| 'unitOfMeasure'
	| 'trackingType'
	| 'lotRule'
	| 'procurement'
	| 'externalPn'
	| 'category'
	| 'description'
	| 'reorderPoint'
	| 'isTooling'
	| 'calibrationIntervalDays'
	| 'metadata';

/**
 * What an active part still has in pencil (RECORDS.md, Part). The owner rules on this list; it is
 * the only place it lives. The server accepts more on an active part than this, never less, so
 * narrowing it is safe and widening it must stay within `updatePart`.
 */
export const ACTIVE_EDITABLE: readonly PartField[] = ['description', 'category', 'reorderPoint'];

const ALL: readonly PartField[] = [
	'name',
	'tier',
	'unitOfMeasure',
	'trackingType',
	'lotRule',
	'procurement',
	'externalPn',
	'category',
	'description',
	'reorderPoint',
	'isTooling',
	'calibrationIntervalDays',
	'metadata'
];

/**
 * The fields this part's state allows to change, less the ones the server would refuse:
 * an obsolete part changes nothing, the tier changes only on a draft that no locked BOM names,
 * the unit stops under stock, PO lines or a locked BOM, and tracking stops under stock records.
 */
export function editableFields(detail: PartDetail): Set<PartField> {
	const { part } = detail;
	if (part.state === 'obsolete') return new Set();
	const fields = new Set(part.state === 'draft' ? ALL : ACTIVE_EDITABLE);
	if (part.state !== 'draft' || detail.identityLocked) fields.delete('tier');
	if (detail.unitLocked) fields.delete('unitOfMeasure');
	if ((detail.references.inventory_records ?? 0) > 0) fields.delete('trackingType');
	return fields;
}
