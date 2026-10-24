/**
 * Loads the dev-only schema builder (src/db/dev-schema.ts) on demand. The specifier is
 * computed so `bun build --compile` does not follow it: drizzle-kit, a dev tool, stays out
 * of the release binary, which never sets OPAL_DEV_SCHEMA.
 */
import type * as DevSchema from './dev-schema.ts';

export function loadDevSchema(): Promise<typeof DevSchema> {
	const specifier = ['./dev-schema', 'ts'].join('.');
	return import(specifier);
}
