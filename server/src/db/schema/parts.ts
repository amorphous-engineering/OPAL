import { PART_STATES, PROCUREMENT, TRACKING_TYPES } from '@opal/shared';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
		state: text('state', { enum: PART_STATES }).notNull().default('draft'),
		activatedAt: text('activated_at'),
		activatedById: integer('activated_by_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('part_state_idx').on(t.state),
		oneOf('part_tracking_check', 'tracking_type', TRACKING_TYPES),
		oneOf('part_procurement_check', 'procurement', PROCUREMENT),
		oneOf('part_state_check', 'state', PART_STATES)
	]
);
