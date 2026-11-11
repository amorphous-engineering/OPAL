/** `opal backup <folder> [--keep <n>]` and `opal restore <backup-folder>`. */
import { type Counts, restoreBackup, takeBackup } from '../services/platform/backup.ts';
import { flag } from './args.ts';
import { USAGE } from './parse.ts';

function usageError(message: string): never {
	console.error(`${message}\n\n${USAGE}`);
	process.exit(2);
}

function describe(counts: Counts): string[] {
	const mb = (counts.databaseBytes / (1024 * 1024)).toFixed(1);
	return [
		`  Database: ${mb} MB`,
		`  Attachment files: ${counts.attachments}${counts.attachmentsLeftOut ? ` (${counts.attachmentsLeftOut} left out: missing or damaged)` : ''}`,
		`  Avatars: ${counts.avatars}`,
		`  Key files: ${counts.keyFiles}`,
		`  Plugin files: ${counts.pluginFiles}`
	];
}

export function backup(args: string[]): void {
	const keepText = flag(args, 'keep');
	if (keepText !== undefined && !/^[1-9]\d*$/.test(keepText)) usageError('--keep needs a whole number of 1 or more');
	const positional = args.filter((a, i) => a !== '--keep' && args[i - 1] !== '--keep');
	if (positional.length !== 1) usageError('opal backup needs one folder to write to');
	try {
		const r = takeBackup(positional[0]!, keepText === undefined ? {} : { keep: Number(keepText) });
		console.log(`Backup finished: ${r.path}`);
		for (const line of describe(r.counts)) console.log(line);
		console.log(r.counts.keyFiles > 0 && r.secretsOpen ? 'This backup holds the database and its keys together. Keep it private.' : 'This backup holds the database. Keep it private.');
		if (r.removed.length) console.log(`  Older backups removed: ${r.removed.length}`);
		if (r.leftAlone) console.log(`  Backups of another instance, or from before instances had ids, left alone: ${r.leftAlone}`);
		for (const name of r.unfinished) console.log(`  Not a finished backup, left alone: ${name}`);
		for (const w of r.warnings) console.warn(`Warning: ${w}`);
	} catch (e) {
		// Written for the person, or the journal of a nightly timer. A stack trace would bury it.
		console.error(`Backup failed: ${(e as Error).message}`);
		process.exit(1);
	}
}

export function restore(args: string[]): void {
	if (args.length !== 1) usageError('opal restore needs one backup folder');
	try {
		const r = restoreBackup(args[0]!);
		console.log(`Restored the backup from ${r.createdAt} into ${r.path}`);
		for (const line of describe(r.counts)) console.log(line);
		if (r.attachmentsLeftOut.length) {
			console.warn(`Warning: this backup left out attachment files that were missing or damaged when it was taken, so this instance lacks them too: ${r.attachmentsLeftOut.join(', ')}. An older backup may hold them.`);
		}
	} catch (e) {
		console.error(`Restore failed: ${(e as Error).message}`);
		process.exit(1);
	}
}
