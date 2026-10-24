/** Data directory, the same location the Python release used. */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function dataDir(): string {
	const env = process.env.OPAL_DATA_DIR;
	if (env) return env;
	if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'OPAL');
	if (platform() === 'win32') {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OPAL');
	}
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opal');
}

/** The live database file. The demo switch points OPAL_DB_FILE at the demo file. */
export const dbPath = () => process.env.OPAL_DB_FILE ?? join(dataDir(), 'opal.db');
