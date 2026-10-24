/**
 * In-memory database built straight from the TypeScript schema, so tests do not
 * depend on generated migrations.
 */
import type { Db } from '../../src/db/client.ts';
import { openSchemaDb } from '../../src/db/dev-schema.ts';

export function openTestDb(): Promise<Db> {
	return openSchemaDb(':memory:');
}
