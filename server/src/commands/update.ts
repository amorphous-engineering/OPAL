/** `opal update`: download, verify and install the latest release. */
import { installUpdate } from '../supervisor/updater.ts';

export async function update(_args: string[]): Promise<void> {
	try {
		const info = await installUpdate(process.execPath);
		if (!info) {
			console.log('OPAL is up to date.');
			return;
		}
		console.log(`Installed ${info.version} (was ${info.current}). Restart the OPAL service to run it.`);
	} catch (e) {
		console.error(`update: ${(e as Error).message}`);
		process.exit(1);
	}
}
