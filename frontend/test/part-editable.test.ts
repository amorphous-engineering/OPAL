import { describe, expect, test } from 'bun:test';
import type { PartDetail } from '@opal/shared';
import { ACTIVE_EDITABLE, editableFields } from '../src/lib/components/parts/editable.ts';

function detail(
	state: 'draft' | 'active' | 'obsolete',
	more: Partial<Pick<PartDetail, 'unitLocked' | 'identityLocked' | 'references'>> = {}
): PartDetail {
	return {
		part: { state },
		unitLocked: false,
		identityLocked: false,
		references: {},
		...more
	} as unknown as PartDetail;
}

describe('what the part page offers to edit', () => {
	test('a draft offers every field', () => {
		const f = editableFields(detail('draft'));
		for (const k of ['name', 'tier', 'unitOfMeasure', 'trackingType', 'metadata'] as const)
			expect(f.has(k)).toBe(true);
	});

	test('an active part offers only its pencil list, and never the tier', () => {
		expect([...editableFields(detail('active'))].sort()).toEqual([...ACTIVE_EDITABLE].sort());
		expect(editableFields(detail('active')).has('tier')).toBe(false);
	});

	test('an obsolete part offers nothing', () => {
		expect(editableFields(detail('obsolete')).size).toBe(0);
	});

	test('a draft named by a locked BOM keeps its tier', () => {
		expect(editableFields(detail('draft', { identityLocked: true })).has('tier')).toBe(false);
	});

	test('the unit stops changing once something counts in it', () => {
		expect(editableFields(detail('draft', { unitLocked: true })).has('unitOfMeasure')).toBe(false);
	});

	test('tracking stops changing under stock records', () => {
		const f = editableFields(detail('draft', { references: { inventory_records: 2 } }));
		expect(f.has('trackingType')).toBe(false);
		expect(f.has('name')).toBe(true);
	});
});
