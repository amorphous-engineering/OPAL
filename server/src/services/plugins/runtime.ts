/**
 * The seam between the plugin host (host.ts, which owns the processes) and
 * everything that asks about them: views, the proxy, panels. Tests and
 * `OPAL_PLUGINS=0` leave the idle runtime in place.
 */
import type { z } from 'zod';
import type { zPluginProcess } from '@opal/shared';

export type PluginProcess = z.infer<typeof zPluginProcess>;

export interface PluginRuntime {
	/** Port the plugin's HTTP server listens on (127.0.0.1), or null when it is not running. */
	port(key: string): number | null;
	process(key: string): PluginProcess;
	/** Last lines of the process output, oldest first. */
	log(key: string): string[];
	/** Start (or restart) the process of an enabled plugin. Reads the database for its row. */
	start(key: string): Promise<void>;
	/** Stop the process and revoke its token. Resolves when it is gone. */
	stop(key: string): Promise<void>;
	/** Stop every process (server shutdown). */
	stopAll(): Promise<void>;
}

const STOPPED: PluginProcess = { state: 'stopped', pid: null, startedAt: null, restarts: 0, exitCode: null };

export const idleRuntime: PluginRuntime = {
	port: () => null,
	process: () => STOPPED,
	log: () => [],
	start: async () => {},
	stop: async () => {},
	stopAll: async () => {}
};

let current: PluginRuntime = idleRuntime;

export function runtime(): PluginRuntime {
	return current;
}

export function setRuntime(r: PluginRuntime): void {
	current = r;
}
