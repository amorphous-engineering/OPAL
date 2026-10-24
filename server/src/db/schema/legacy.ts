/**
 * Tables that only the one-time import writes.
 *
 * `legacy_audit` holds the Python-era `audit_log` rows unchanged: the old column names and the
 * old value formats stay as they were. `legacy_row` keeps a legacy row that has no home in the
 * new schema (or none that a check allows), as JSON with the reason, so no data is lost.
 * Neither table is written after the import.
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const legacyAudit = sqliteTable('legacy_audit', {
	id: integer('id').primaryKey(),
	timestamp: text('timestamp').notNull(),
	tableName: text('table_name').notNull(),
	recordId: integer('record_id').notNull(),
	action: text('action').notNull(),
	userId: integer('user_id'),
	oldValues: text('old_values'),
	newValues: text('new_values')
});

export const legacyRow = sqliteTable('legacy_row', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	/** The legacy table name. */
	tableName: text('table_name').notNull(),
	/** The legacy row id, when the table has one. */
	rowId: integer('row_id'),
	reason: text('reason').notNull(),
	data: text('data', { mode: 'json' }).notNull()
});
