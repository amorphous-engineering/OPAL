/**
 * `opal import <legacy.db> [--out <new.db>] [--project <opal.project.yaml>] [--attachments <dir>]`:
 * one-time import of a Python-era database that is not in the data folder. One that is gets
 * imported in place by the next start.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { importLegacy as runImport, renderReport, reportSummary, writeReports } from '../import/index.ts';
import { hardenDataDir } from '../harden.ts';
import { dbPath } from '../paths.ts';
import { flag } from './args.ts';

export async function importLegacy(args: string[]): Promise<void> {
	const out = flag(args, 'out');
	const projectFile = flag(args, 'project');
	const attachmentsDir = flag(args, 'attachments');
	const takesValue = ['--out', '--project', '--attachments'];
	const src = args.find((a, i) => !a.startsWith('--') && !takesValue.includes(args[i - 1] ?? ''));
	if (!src) {
		console.error('Usage: opal import <legacy.db> [--out <new.db>] [--project <opal.project.yaml>] [--attachments <folder>]');
		process.exit(2);
	}
	hardenDataDir();
	const dest = out ?? dbPath();
	if (existsSync(src) && existsSync(dest) && realpathSync(src) === realpathSync(dest)) {
		console.error(`${src} is already in the data folder. Start OPAL and it is imported in place, with the old file kept as opal.legacy.db.`);
		process.exit(1);
	}
	try {
		const report = await runImport(src, dest, { projectFile, attachmentsDir });
		console.log(renderReport(report));
		writeReports(report, dirname(dest));
		console.log(reportSummary(report, dirname(dest)));
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
