/** A start with a 1.x database in the data folder, through the real command line. */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMPORTED_EXIT, importingResponse, importInPlace, openSchemaImportDb, runImportChild } from '../src/import/index.ts';
import { Child } from '../src/supervisor/child.ts';
import { buildLegacyFixture } from './fixtures/legacy-data.ts';

const FIXTURES = join(import.meta.dir, 'fixtures/legacy-released');
const CLI = join(import.meta.dir, '../src/cli.ts');
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-import-serve-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const freePort = () => {
	const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
	const port = probe.port!;
	probe.stop(true);
	return port;
};

function released(name: string, dir: string): string {
	const path = join(dir, 'opal.db');
	writeFileSync(path, Bun.gunzipSync(new Uint8Array(readFileSync(join(FIXTURES, `${name}.db.gz`)))));
	const files = join(FIXTURES, `${name}.attachments.tgz`);
	if (existsSync(files)) Bun.spawnSync(['tar', '-xzf', files, '-C', dir]);
	const project = join(FIXTURES, `${name}.project.yaml`);
	if (existsSync(project)) writeFileSync(join(dir, 'opal.project.yaml'), readFileSync(project));
	return path;
}

const env = (dir: string) => ({ ...process.env, OPAL_DATA_DIR: dir, OPAL_PLUGINS: '0', OPAL_SECRETS_KEY: 'test-only-secrets-key-0123456789abcdef' });

async function waitFor(check: () => Promise<boolean> | boolean, ms = 60_000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await Bun.sleep(50);
	}
	return false;
}

function serve(dir: string, port: number) {
	return Bun.spawn([process.execPath, CLI, 'serve', '--port', String(port), '--host', '127.0.0.1'], { env: env(dir), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
}

describe('opal serve', () => {
	test('imports a released database and then serves it', async () => {
		const dir = tmp();
		released('v1.3.2', dir);
		const port = freePort();
		const proc = serve(dir, port);
		try {
			const up = await waitFor(async () => {
				const res = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
				const body = res?.ok ? ((await res.json()) as { status?: string }) : null;
				return !!body && body.status !== 'importing';
			});
			expect(up).toBe(true);
			expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(true);
			expect(existsSync(join(dir, 'import-report.txt'))).toBe(true);
			expect(readdirSync(dir).filter((n) => n.startsWith('opal-import-src-'))).toEqual([]);
		} finally {
			proc.kill();
			await proc.exited;
		}
		const out = await new Response(proc.stdout).text();
		expect(out).toContain('Imported the OPAL 1.3.2 database');
		expect(out).toContain('Importing: parts and purchasing');
	}, 90_000);

	test('a refused import stops the start, says why, and leaves the file', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const before = sha(src);
		const proc = serve(dir, freePort());
		const code = await proc.exited;
		expect(code).toBe(1);
		expect(await new Response(proc.stderr).text()).toContain('--accept-failed-rows');
		expect(sha(src)).toBe(before);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(false);
		expect(existsSync(join(dir, 'import-report.txt'))).toBe(true);
	}, 60_000);

	test('the answer to a refusal is opal import on the same file', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const proc = Bun.spawn([process.execPath, CLI, 'import', src, '--accept-failed-rows'], { env: env(dir), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
		expect(await proc.exited).toBe(0);
		expect(await new Response(proc.stdout).text()).toContain('(accepted)');
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(true);
	}, 60_000);

	test('an import whose start has gone stops by itself', async () => {
		const dir = tmp();
		const src = released('v1.3.2', dir);
		const before = sha(src);
		const proc = Bun.spawn([process.execPath, CLI, 'import', src], { env: { ...env(dir), OPAL_IMPORT_PARENT: '1' }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
		expect(await proc.exited).toBe(1);
		expect(await new Response(proc.stderr).text()).toContain('has stopped');
		expect(sha(src)).toBe(before);
		expect(readdirSync(dir).filter((n) => n.startsWith('opal-import-src-') || n.startsWith('opal.db.'))).toEqual([]);
	}, 60_000);

	test('a port that is taken stops the start before anything is read', async () => {
		const dir = tmp();
		const src = released('v1.3.2', dir);
		const taken = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
		const before = readdirSync(dir).sort();
		try {
			const proc = serve(dir, taken.port!);
			expect(await proc.exited).toBe(1);
			expect(await new Response(proc.stderr).text()).toContain('Could not listen');
		} finally {
			taken.stop(true);
		}
		expect(existsSync(src)).toBe(true);
		expect(readdirSync(dir).sort()).toEqual(before);
	}, 60_000);
});

describe('while an import runs', () => {
	test('the health check is answered and nothing else is', async () => {
		expect((await importingResponse(new Request('http://x/api/health')).json()) as object).toEqual({ status: 'importing' });
		expect(importingResponse(new Request('http://x/api/parts')).status).toBe(503);
		expect(importingResponse(new Request('http://x/')).status).toBe(503);
	});

	test('whatever started OPAL does not kill an import that outlasts its wait', async () => {
		const dir = tmp();
		const port = freePort();
		const script = join(dir, 'start.ts');
		writeFileSync(
			script,
			`import { importingResponse, runImportChild } from ${JSON.stringify(join(import.meta.dir, '../src/import/index.ts'))};
			Bun.serve({ port: ${port}, hostname: '127.0.0.1', fetch: importingResponse });
			const outcome = await runImportChild([process.execPath, '-e', 'await Bun.sleep(1500); process.exit(${IMPORTED_EXIT})'], ${JSON.stringify(join(dir, 'opal.db'))});
			console.log('outcome ' + outcome);
			process.exit(0);`
		);
		const child = new Child({ command: () => [process.execPath, script], port, healthTimeoutMs: 400, healthPollMs: 50 });
		child.start();
		expect(await child.waitRunning(5000)).toBe(true);
		await waitFor(() => child.state !== 'running', 10_000);
		expect(child.log().join('\n')).toContain('outcome imported');
		expect(child.log().join('\n')).not.toContain('health check timed out');
		await child.stop();
	}, 30_000);

	test('stopping the start stops the import and leaves no copy and no half-made result', async () => {
		const dir = tmp();
		const script = join(dir, 'start.ts');
		const db = join(dir, 'opal.db');
		const copy = join(dir, 'opal-import-src-running');
		const worker = `require('node:fs').mkdirSync(${JSON.stringify(copy)}); require('node:fs').writeFileSync(${JSON.stringify(`${db}.new`)}, 'half'); console.log('started'); await Bun.sleep(30000);`;
		writeFileSync(
			script,
			`import { runImportChild } from ${JSON.stringify(join(import.meta.dir, '../src/import/index.ts'))};
			const outcome = await runImportChild([process.execPath, '-e', ${JSON.stringify(worker)}], ${JSON.stringify(db)});
			console.log('outcome ' + outcome);
			process.exit(outcome === 'stopped' ? 143 : 0);`
		);
		const proc = Bun.spawn([process.execPath, script], { env: env(dir), stdout: 'pipe', stderr: 'inherit', stdin: 'ignore' });
		expect(await waitFor(() => existsSync(`${db}.new`), 10_000)).toBe(true);
		proc.kill('SIGTERM');
		expect(await proc.exited).toBe(143);
		expect(existsSync(copy)).toBe(false);
		expect(existsSync(`${db}.new`)).toBe(false);
	}, 30_000);

	test('an import told to stop mid-way leaves nothing, and the original stays', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const before = sha(src);
		const open = (path: string) => openSchemaImportDb(path);
		const onProgress = (what: string) => {
			if (what === 'procedures') throw new Error('The start that asked for this import has stopped.');
		};
		await expect(importInPlace(src, { open, acceptFailedRows: true, onProgress })).rejects.toThrow('has stopped');
		expect(sha(src)).toBe(before);
		const left = readdirSync(dir).filter((n) => n !== 'opal.db' && n !== 'attachments');
		expect(left.filter((n) => n.startsWith('opal-import-src-') || n.startsWith('opal.db.'))).toEqual([]);
	});

	test('an import told to stop just before the swap keeps the old file in place', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const open = (path: string) => openSchemaImportDb(path);
		const onProgress = (what: string) => {
			if (what.startsWith('putting')) throw new Error('stopped');
		};
		await expect(importInPlace(src, { open, acceptFailedRows: true, onProgress })).rejects.toThrow('stopped');
		expect(existsSync(`${src}.new`)).toBe(false);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(false);
		new Database(src).close();
	});

	test('a child that imported is told apart from one with nothing to do', async () => {
		const dir = tmp();
		mkdirSync(dir, { recursive: true });
		const db = join(dir, 'opal.db');
		expect(await runImportChild([process.execPath, '-e', `process.exit(${IMPORTED_EXIT})`], db)).toBe('imported');
		expect(await runImportChild([process.execPath, '-e', 'process.exit(0)'], db)).toBe('nothing');
		expect(await runImportChild([process.execPath, '-e', 'process.exit(1)'], db)).toBe('failed');
	});
});
