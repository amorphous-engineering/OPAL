/** `opal import <legacy.db> [--out <new.db>]`: one-time import of a Python-era database. */
import { importLegacy as runImport, renderReport } from '../import/index.ts';
import { dbPath } from '../paths.ts';
import { flag } from './args.ts';

export function importLegacy(args: string[]): void {
	const out = flag(args, 'out');
	const src = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
	if (!src) {
		console.error('Usage: opal import <legacy.db> [--out <new.db>]');
		process.exit(2);
	}
	try {
		console.log(renderReport(runImport(src, out ?? dbPath())));
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
