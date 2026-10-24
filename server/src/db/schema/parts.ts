import { PART_STATES, PROCUREMENT, TRACKING_TYPES } from '@opal/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';

export const part = sqliteTable(
	'part',
	{
		id: id(),
		internalPn: text('internal_pn').notNull().unique(),
		externalPn: text('external_pn'),
		name: text('name').notNull(),
		description: text('description'),
		category: text('category'),
		unitOfMeasure: text('unit_of_measure').notNull(),
		trackingType: text('tracking_type', { enum: TRACKING_TYPES }).notNull(),
		procurement: text('procurement', { enum: PROCUREMENT }).notNull(),
		tier: integer('tier').notNull(),
		reorderPoint: integer('reorder_point'),
		isTooling: integer('is_tooling', { mode: 'boolean' }).notNull().default(false),
		calibrationIntervalDays: integer('calibration_interval_days'),
		/** Project-defined fields (`custom_fields` in the project configuration), validated on write. */
		metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
		state: text('state', { enum: PART_STATES }).notNull().default('draft'),
		activatedAt: text('activated_at'),
		activatedById: integer('activated_by_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		activationCause: text('activation_cause'),
		obsoletedAt: text('obsoleted_at'),
		obsoletedById: integer('obsoleted_by_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		obsoleteCause: text('obsolete_cause'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('part_state_idx').on(t.state),
		index('part_external_pn_idx').on(t.externalPn),
		index('part_category_idx').on(t.category),
		index('part_tier_idx').on(t.tier),
		oneOf('part_tracking_check', 'tracking_type', TRACKING_TYPES),
		oneOf('part_procurement_check', 'procurement', PROCUREMENT),
		oneOf('part_state_check', 'state', PART_STATES)
	]
);

/**
 * Design-level structure: `quantity` of `component` goes into one `assembly`. The only home
 * for assembly structure (legacy `part.parent_id` became a line with quantity 1).
 */
export const bomLine = sqliteTable(
	'bom_line',
	{
		id: id(),
		assemblyId: integer('assembly_id')
			.notNull()
			.references(() => part.id),
		componentId: integer('component_id')
			.notNull()
			.references(() => part.id),
		/** Qty units. Always above zero. */
		quantity: integer('quantity').notNull().default(10000),
		referenceDesignator: text('reference_designator'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('bom_line_pair').on(t.assemblyId, t.componentId),
		index('bom_line_component_idx').on(t.componentId),
		check('bom_line_quantity_positive', sql`"quantity" > 0`),
		check('bom_line_not_self', sql`"assembly_id" <> "component_id"`)
	]
);

/**
 * Part numbers that left the part table (deleted drafts, numbers a draft gave up when its tier
 * changed). They stay taken, so a number is never issued twice.
 */
export const retiredPartNumber = sqliteTable('retired_part_number', {
	id: id(),
	internalPn: text('internal_pn').notNull().unique(),
	reason: text('reason').notNull(),
	retiredAt: text('retired_at').notNull()
});
