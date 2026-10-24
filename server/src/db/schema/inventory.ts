/**
 * Tables for the inventory area.
 *
 * `stock_record` is one physical lot or serial at a location. It has no quantity. The balance
 * of a record is the sum of its `stock_move.qty` (see services/inventory/ledger.ts).
 */
import { sql } from 'drizzle-orm';
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	sqliteTable,
	text
} from 'drizzle-orm/sqlite-core';
import {
	MOVE_KINDS,
	STOCK_SOURCES,
	STOCK_TEST_RESULTS,
	STOCK_TEST_TYPES
} from '@opal/shared';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { part } from './parts.ts';
import { purchaseLine } from './purchasing.ts'; // added by purchasing

export const stockRecord = sqliteTable(
	'stock_record',
	{
		id: id(),
		partId: integer('part_id')
			.notNull()
			.references(() => part.id),
		/** OPAL-00001. Handed out once, never reused. */
		opalNumber: text('opal_number').notNull().unique(),
		location: text('location').notNull(),
		lotNumber: text('lot_number'),
		serialNumber: text('serial_number'),
		alias: text('alias'),
		sourceType: text('source_type', { enum: STOCK_SOURCES }).notNull().default('manual'),
		/** A calendar date, YYYY-MM-DD. */
		expirationDate: text('expiration_date'),
		lastCalibratedAt: text('last_calibrated_at'),
		calibrationDueAt: text('calibration_due_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('stock_record_part_idx').on(t.partId),
		index('stock_record_location_idx').on(t.location),
		index('stock_record_lot_idx').on(t.lotNumber),
		index('stock_record_expiration_idx').on(t.expirationDate),
		index('stock_record_calibration_idx').on(t.calibrationDueAt),
		oneOf('stock_record_source_check', 'source_type', STOCK_SOURCES)
	]
);

/**
 * The ledger. One row per change of a record's balance. Rows are never edited or deleted,
 * with one exception: `into_stock_id` is set once when a consume move is linked to the
 * assembly it went into.
 *
 * Link columns for other areas are added here by their owners, each nullable:
 *   purchasing: the purchase line a receive came from
 *   execution:  the execution and step execution a consume or produce belongs to
 */
export const stockMove = sqliteTable(
	'stock_move',
	{
		id: id(),
		stockId: integer('stock_id')
			.notNull()
			.references(() => stockRecord.id),
		kind: text('kind', { enum: MOVE_KINDS }).notNull(),
		/**
		 * Signed Qty. receive and produce add. consume removes (zero for tooling that is used
		 * and returned). adjust and count carry the difference. transfer is the half that
		 * leaves (negative) or arrives (positive), or zero when a whole record is relocated.
		 */
		qty: integer('qty').notNull(),
		/** adjust: found, correction, damage, scrap, import. consume: scrap, tooling. */
		reason: text('reason'),
		notes: text('notes'),
		actorUserId: integer('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
		at: text('at').notNull(),
		/** Transfers only: where the stock was and where it went, as they were at the time. */
		fromLocation: text('from_location'),
		toLocation: text('to_location'),
		fromLot: text('from_lot'),
		toLot: text('to_lot'),
		/** The other half of a transfer. */
		counterpartId: integer('counterpart_id').references((): AnySQLiteColumn => stockMove.id),
		/**
		 * Genealogy: a consume move names the stock record it went into. Components of an
		 * assembly are the consume moves with `into_stock_id` = the assembly record.
		 */
		intoStockId: integer('into_stock_id').references(() => stockRecord.id),
		// added by purchasing: the purchase line a receive move came from
		purchaseLineId: integer('purchase_line_id').references(() => purchaseLine.id),
	},
	(t) => [
		index('stock_move_stock_idx').on(t.stockId, t.at),
		index('stock_move_kind_idx').on(t.kind),
		index('stock_move_into_idx').on(t.intoStockId),
		index('stock_move_purchase_line_idx').on(t.purchaseLineId), // added by purchasing
		oneOf('stock_move_kind_check', 'kind', MOVE_KINDS),
		check(
			'stock_move_sign_check',
			sql`(${t.kind} IN ('receive', 'produce') AND ${t.qty} > 0)
				OR (${t.kind} = 'consume' AND ${t.qty} <= 0)
				OR ${t.kind} IN ('adjust', 'count', 'transfer')`
		),
		check('stock_move_into_check', sql`${t.intoStockId} IS NULL OR ${t.kind} = 'consume'`)
	]
);

export const testTemplate = sqliteTable(
	'test_template',
	{
		id: id(),
		partId: integer('part_id')
			.notNull()
			.references(() => part.id),
		name: text('name').notNull(),
		description: text('description'),
		required: integer('required', { mode: 'boolean' }).notNull().default(false),
		testType: text('test_type', { enum: STOCK_TEST_TYPES }).notNull().default('boolean'),
		minValue: integer('min_value'),
		maxValue: integer('max_value'),
		unit: text('unit'),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('test_template_part_idx').on(t.partId),
		oneOf('test_template_type_check', 'test_type', STOCK_TEST_TYPES)
	]
);

export const stockTestResult = sqliteTable(
	'stock_test_result',
	{
		id: id(),
		stockId: integer('stock_id')
			.notNull()
			.references(() => stockRecord.id),
		templateId: integer('template_id').references(() => testTemplate.id, {
			onDelete: 'set null'
		}),
		/** Kept on the row so a deleted template leaves its results readable. */
		testName: text('test_name').notNull(),
		result: text('result', { enum: STOCK_TEST_RESULTS }).notNull().default('pending'),
		value: text('value'),
		notes: text('notes'),
		testedAt: text('tested_at'),
		testedById: integer('tested_by_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('stock_test_result_stock_idx').on(t.stockId),
		oneOf('stock_test_result_check', 'result', STOCK_TEST_RESULTS)
	]
);
