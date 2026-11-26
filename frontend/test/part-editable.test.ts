import { describe, expect, test } from 'bun:test';
import { PART_FIELDS, type PartDetail } from '@opal/shared';
import { editableFields } from '../src/lib/components/parts/editable.ts';

function detail(
	state: 'draft' | 'active' | 'obsolete',
	more: Partial<Pick<PartDetail, 'unitLocked' | 'identityLocked' | 'trackingLocked'>> = {}
): PartDetail {
	return {
		part: { state },
		unitLocked: false,
		identityLocked: false,
		trackingLocked: false,
		references: {},
		...more
	} as unknown as PartDetail;
}

describe('what the part page offers to edit', () => {
	test('a draft offers every field', () => {
		expect([...editableFields(detail('draft'))].sort()).toEqual([...PART_FIELDS].sort());
	});

	test('an active part offers everything but its tier', () => {
		expect([...editableFields(detail('active'))].sort()).toEqual(
			PART_FIELDS.filter((f) => f !== 'tier').sort()
		);
	});

	test('an obsolete part offers nothing', () => {
		expect(editableFields(detail('obsolete')).size).toBe(0);
	});

	test('a draft named by a locked BOM keeps its tier', () => {
		expect(editableFields(detail('draft', { identityLocked: true })).has('tier')).toBe(false);
	});

	test('the unit stops changing once something counts in it', () => {
		for (const s of ['draft', 'active'] as const)
			expect(editableFields(detail(s, { unitLocked: true })).has('unitOfMeasure')).toBe(false);
	});

	test('tracking stops changing under stock records', () => {
		for (const s of ['draft', 'active'] as const) {
			const f = editableFields(detail(s, { trackingLocked: true }));
			expect(f.has('trackingType')).toBe(false);
			expect(f.has('name')).toBe(true);
		}
	});
});
