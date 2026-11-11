/**
 * `opal import <legacy.db> [--out <new.db>] [--project <opal.project.yaml>] [--attachments <dir>] [--accept-failed-rows]`:
 * one-time import of a Python-era database. One in the data folder is imported in place, with the old
 * file kept as opal.legacy.db, as the next start would. This is how a start's refusal is answered.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { IMPORTED_EXIT, importInPlace, importLegacy as runImport, PARENT_ENV, renderReport, reportSummary, writeReports } from '../import/index.ts';
import { hardenDataDir } from '../harden.ts';
import { dbPath } from '../paths.ts';
import { flag } from './args.ts';

export async function importLegacy(args: string[]): Promise<void> {
	const out = flag(args, 'out');
	const projectFile = flag(args, 'project');
	const attachmentsDir = flag(args, 'attachments');
	const acceptFailedRows = args.includes('--accept-failed-rows');
	const takesValue = ['--out', '--project', '--attachments'];
	const src = args.find((a, i) => !a.startsWith('--') && !takesValue.includes(args[i - 1] ?? ''));
	if (!src) {
		console.error('Usage: opal import <legacy.db> [--out <new.db>] [--project <opal.project.yaml>] [--attachments <folder>] [--accept-failed-rows]');
		process.exit(2);
	}
	hardenDataDir();
	const dest = out ?? dbPath();
	// Started by `opal serve`: stop when it is gone, so a killed start leaves nothing working behind it.
	const parent = process.env[PARENT_ENV];
	const onProgress = (what: string) => {
		if (parent && String(process.ppid) !== parent) throw new Error('The start that asked for this import has stopped.');
		console.log(`Importing: ${what}`);
	};
	const inPlace = resolve(src) === resolve(dest) || (existsSync(src) && existsSync(dest) && realpathSync(src) === realpathSync(dest));
	try {
		if (inPlace) {
			const report = await importInPlace(dest, { projectFile, attachmentsDir, acceptFailedRows, onProgress });
			if (report) console.log(reportSummary(report, dirname(dest)));
			else if (!parent) console.log(`${dest} is already an OPAL 2 database. There is nothing to import.`);
			if (report && parent) process.exit(IMPORTED_EXIT);
			return;
		}
		const report = await runImport(src, dest, { projectFile, attachmentsDir, acceptFailedRows, onProgress });
		console.log(renderReport(report));
		writeReports(report, dirname(dest));
		console.log(reportSummary(report, dirname(dest)));
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
