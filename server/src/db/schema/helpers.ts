/**
 * Column helpers shared by every schema file.
 *
 * Conventions: INTEGER PRIMARY KEY AUTOINCREMENT, so ids are never reused.
 * Timestamps are ISO 8601 UTC text. Quantities are integers in Qty units.
 * Every enum column has a CHECK generated from the shared enum.
 */
import { sql } from 'drizzle-orm';
import { check, integer, text } from 'drizzle-orm/sqlite-core';

export const id = () => integer('id').primaryKey({ autoIncrement: true });
export const createdAt = () => text('created_at').notNull();
export const updatedAt = () => text('updated_at').notNull();

/** CHECK (col IN (...)) from a shared enum. */
export function oneOf(name: string, col: string, values: readonly string[]) {
	return check(name, sql.raw(`"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`));
}
