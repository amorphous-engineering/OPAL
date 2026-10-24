/** Assets baked into the compiled binary. The build entry sets them before the CLI loads. */
import type { MigrationMeta } from 'drizzle-orm/migrator';

export interface Embedded {
	migrations: MigrationMeta[];
	/** URL path without a leading slash, to an embedded file path for `Bun.file()`. */
	web: Record<string, string>;
	/** Embedded path of the demo seed database (server/assets/demo-seed.db). */
	demoSeed?: string;
}

declare global {
	// eslint-disable-next-line no-var
	var __opalEmbedded: Embedded | undefined;
}

export const embedded = (): Embedded | undefined => globalThis.__opalEmbedded;
