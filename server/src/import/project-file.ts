/**
 * Before 1.4 the project configuration (name, tiers, part numbering, categories) lived in
 * `opal.project.yaml`, not in the database. 1.4 read that file once into app_setting. This does
 * the same, on the private copy, for a database that never got that far.
 */
import type { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ImportReport } from './context.ts';

const FILENAME = 'opal.project.yaml';
const MAX_BYTES = 1024 * 1024;

/** A project keeps its database in `<project>/data` or beside it. This decides the numbering of every record, so nothing further away is taken on sight. */
const nearby = (srcPath: string) => [join(dirname(srcPath), FILENAME), join(dirname(dirname(srcPath)), FILENAME)];

/** 1.x looked in the current folder and its parents. One there is mentioned, and used only if someone names it. */
function further(): string | undefined {
	for (let dir = process.cwd(); ; dir = dirname(dir)) {
		const path = join(dir, FILENAME);
		if (existsSync(path)) return path;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * A YAML alias expands inside the parser, so a small file can take all the memory there is. 1.x never
 * needs one here. Looks where a value starts, which is the only place an anchor or alias can be.
 */
const ALIAS = /(?:^|:\s|-\s|[[{,]\s*)\s*[&*][^\s,[\]{}]+/m;

function readConfig(path: string): Record<string, unknown> {
	const stat = lstatSync(path);
	if (!stat.isFile()) throw new Error('it is not a regular file');
	if (stat.size > MAX_BYTES) throw new Error(`it is ${stat.size} bytes, more than a project file holds`);
	const text = readFileSync(path, 'utf8');
	if (ALIAS.test(text)) throw new Error('it uses YAML anchors or aliases');
	const cfg = Bun.YAML.parse(text) as Record<string, unknown>;
	if (!cfg || typeof cfg !== 'object' || typeof cfg.name !== 'string') throw new Error('it has no project name');
	return cfg;
}

export function addProjectFile(src: Database, srcPath: string, explicit: string | undefined, report: ImportReport): void {
	const stored = src.query("SELECT value FROM app_setting WHERE key = 'project_config'").get() as { value: string | null } | null;
	if (stored?.value) return;
	if (explicit && !existsSync(explicit)) throw new Error(`Project file not found: ${explicit}. The source file was not changed.`);
	const path = explicit ?? nearby(srcPath).find((p) => existsSync(p));
	if (!path) {
		const elsewhere = further();
		report.warnings.push(`no ${FILENAME} beside the database: the project is named "Imported project" with the default tiers and part numbering. ${elsewhere ? `There is one at ${elsewhere}, which was not used because nothing ties it to this database. If it is the right one` : 'If you have the file'}, use: opal import <database> --project <file>`);
		return;
	}
	let cfg: Record<string, unknown>;
	try {
		cfg = readConfig(path);
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
