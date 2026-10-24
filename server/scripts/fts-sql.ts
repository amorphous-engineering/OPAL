/**
 * Prints the SQL that creates every global-search index: one FTS5 table per
 * registered searchable, its sync triggers, and a rebuild. Paste the output
 * into a custom migration (`drizzle-kit generate --custom`) that runs after
 * the indexed tables exist. Every statement is idempotent.
 *
 *   bun scripts/fts-sql.ts
 */
import '../src/ops/index.ts'; // loads every area, so every registerSearchable runs
import { ftsStatements } from '../src/services/platform/search.ts';

for (const stmt of ftsStatements()) console.log(`${stmt};\n--> statement-breakpoint`);
