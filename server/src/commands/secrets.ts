/**
 * `opal secrets rotate`: replace the key in the key file and reseal everything with the new one.
 * Stop OPAL first. If this stops partway, the file keeps both keys, nothing becomes unreadable, and
 * running it again finishes the job.
 */
import { existsSync } from 'node:fs';
import { addKeyToFile, dropOldKeysFromFile, keyFilePath } from '../auth/sealed.ts';
import { openDb } from '../db/client.ts';
import { sweepCopies } from '../db/seal-secrets.ts';
import { hardenDataDir } from '../harden.ts';
import { dbPath } from '../paths.ts';

export function rotateSecretsKey(): boolean {
	addKeyToFile();
	if (existsSync(dbPath())) openDb(dbPath()).$client.close();
	if (!sweepCopies(dbPath())) return false;
	dropOldKeysFromFile();
	return true;
}

export function secrets(args: string[]): void {
	if (args[0] !== 'rotate') {
		console.error('Usage: opal secrets rotate');
		process.exit(2);
	}
	if (process.env.OPAL_SECRETS_KEY) {
		console.error(
			'The key comes from OPAL_SECRETS_KEY, so there is no file to rotate. Move its value to OPAL_SECRETS_KEY_PREVIOUS, set a new OPAL_SECRETS_KEY, start OPAL once, then remove OPAL_SECRETS_KEY_PREVIOUS.'
		);
		process.exit(2);
	}
	hardenDataDir();
	if (!rotateSecretsKey()) {
		console.error(`Some copies could not be resealed, so ${keyFilePath()} keeps the old key too. Fix what is listed above and run this again.`);
		process.exit(1);
	}
	console.log(`The secrets are sealed with a new key in ${keyFilePath()}. Back up the data folder again: an older backup needs its own older key.`);
}
