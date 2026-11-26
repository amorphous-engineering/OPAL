import { editablePartFields, type PartDetail, type PartField } from '@opal/shared';

export type { PartField };

/**
 * The fields the part page offers under EDIT: exactly what `parts.update` would accept, by the
 * same rule the server refuses with (`partFieldLock` in shared).
 */
export function editableFields(detail: PartDetail): Set<PartField> {
	return editablePartFields(detail.part.state, detail);
}
