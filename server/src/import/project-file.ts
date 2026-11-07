/**
 * Before 1.4 the project configuration (name, tiers, part numbering, categories) lived in
 * `opal.project.yaml`, not in the database. 1.4 read that file once into app_setting. This does
 * the same, on the private copy, for a database that never got that far.
 */
import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ImportReport } from './context.ts';

const FILENAME = 'opal.project.yaml';

/** 1.x searched the current folder and its parents. A project keeps its database in `<project>/data`. */
function candidates(srcPath: string): string[] {
	const found = [join(dirname(srcPath), FILENAME), join(dirname(dirname(srcPath)), FILENAME)];
	let dir = process.cwd();
	for (;;) {
		found.push(join(dir, FILENAME));
		const up = dirname(dir);
		if (up === dir) return found;
		dir = up;
	}
}

export function addProjectFile(src: Database, srcPath: string, explicit: string | undefined, report: ImportReport): void {
	const stored = src.query("SELECT value FROM app_setting WHERE key = 'project_config'").get() as { value: string | null } | null;
	if (stored?.value) return;
	if (explicit && !existsSync(explicit)) throw new Error(`Project file not found: ${explicit}. The source file was not changed.`);
	const path = explicit ?? candidates(srcPath).find((p) => existsSync(p));
	if (!path) {
		report.warnings.push(`no ${FILENAME} found: the project is named "Imported project" with the default tiers and part numbering. If you have the file, use: opal import <database> --project <file>`);
		return;
	}
	let cfg: Record<string, unknown>;
	try {
		cfg = Bun.YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		if (!cfg || typeof cfg !== 'object' || typeof cfg.name !== 'string') throw new Error('it has no project name');
	} catch (e) {
		report.warnings.push(`${path} could not be read (${e instanceof Error ? e.message : String(e)}): the project is named "Imported project" with the default tiers and part numbering`);
		return;
	}
	const at = new Date().toISOString().replace('T', ' ').replace('Z', '000');
	src.run(
		"INSERT INTO app_setting (key, value, created_at, updated_at) VALUES ('project_config', ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
		[JSON.stringify(cfg), at, at]
	);
	report.projectFile = path;
}
