/**
 * `opal secrets rotate`: replace the key in the key file and reseal everything with the new one.
 * Stop OPAL first. If this stops partway, the file keeps both keys, nothing becomes unreadable, and
 * running it again finishes the job.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { addKeyToFile, dropOldKeysFromFile, keyFilePath } from '../auth/sealed.ts';
import { openDb } from '../db/client.ts';
import { sweepCopies, unreadableSecrets } from '../db/seal-secrets.ts';
import { hardenDataDir } from '../harden.ts';
import { hasAlembicVersion } from '../import/index.ts';
import { dbPath } from '../paths.ts';

/**
 * Why a rotation would not do what it says, or null. It only looks, so a refusal leaves the folder as
 * it was. A new key cannot help a secret no key here opens: the usual cause is a server that gets its
 * key from OPAL_SECRETS_KEY, and it would go on using that key whatever this wrote.
 */
export function rotationRefusal(): string | null {
	if (!existsSync(dbPath())) return null;
	if (hasAlembicVersion(dbPath())) return `${dbPath()} is a 1.x database. Start OPAL once to import it, then run this again.`;
	const sqlite = new Database(dbPath(), { readonly: true, strict: true });
	try {
		const unreadable = unreadableSecrets(sqlite);
		if (!unreadable.length) return null;
		return (
			`Nothing changed: these stored secrets cannot be read with the key available here: ${unreadable.join(', ')}. ` +
			'If OPAL runs with OPAL_SECRETS_KEY, change the key as the README describes for the variable. Otherwise restore the key from a backup, or enter the secrets again in Settings, then run this again.'
		);
	} finally {
		sqlite.close();
	}
}

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
	const refusal = rotationRefusal();
	if (refusal) {
		console.error(refusal);
		process.exit(1);
	}
	if (!rotateSecretsKey()) {
		console.error(`Some copies could not be resealed, so ${keyFilePath()} keeps the old key too. Fix what is listed above and run this again.`);
		process.exit(1);
	}
	console.log(`The secrets are sealed with a new key in ${keyFilePath()}. Back up the data folder again: an older backup needs its own older key.`);
}
