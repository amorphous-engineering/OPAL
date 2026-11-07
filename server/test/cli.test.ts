import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand } from '../src/commands/parse.ts';

describe('what the command line asks for', () => {
	test('asking for help never starts anything, wherever the flag sits', () => {
		for (const argv of [['--help'], ['-h'], ['help'], ['serve', '--help'], ['update', '-h'], ['import', 'a.db', '--help']]) {
			expect(parseCommand(argv)).toEqual({ kind: 'help' });
		}
	});

	test('a flag nobody knows is refused instead of starting the supervisor', () => {
		expect(parseCommand(['--bogus'])).toEqual({ kind: 'error', message: 'Unknown flag for supervise: --bogus' });
		expect(parseCommand(['serve', '--no-browser'])).toEqual({ kind: 'error', message: 'Unknown flag for serve: --no-browser' });
		expect(parseCommand(['nonsense'])).toEqual({ kind: 'error', message: 'Unknown command: nonsense' });
	});

	test('a flag that takes a value needs one', () => {
		expect(parseCommand(['--port'])).toEqual({ kind: 'error', message: '--port needs a value' });
		expect(parseCommand(['--port', '--no-browser'])).toEqual({ kind: 'error', message: '--port needs a value' });
	});

	test('the supported forms still run what they always ran', () => {
		expect(parseCommand([])).toEqual({ kind: 'run', command: 'supervise', args: [] });
		expect(parseCommand(['--port', '9000', '--no-browser'])).toEqual({ kind: 'run', command: 'supervise', args: ['--port', '9000', '--no-browser'] });
		expect(parseCommand(['serve', '--host', '127.0.0.1'])).toEqual({ kind: 'run', command: 'serve', args: ['--host', '127.0.0.1'] });
		expect(parseCommand(['import', 'old.db', '--out', 'dir'])).toEqual({ kind: 'run', command: 'import', args: ['old.db', '--out', 'dir'] });
		expect(parseCommand(['--version'])).toEqual({ kind: 'run', command: 'version', args: [] });
		expect(parseCommand(['-v'])).toEqual({ kind: 'run', command: 'version', args: [] });
	});

	test('help and a wrong flag leave the data folder untouched', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'opal-cli-'));
		const data = join(dir, 'data');
		try {
			for (const [args, code] of [
				[['--help'], 0],
				[['--bogus'], 2]
			] as const) {
				const p = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
					env: { ...process.env, OPAL_DATA_DIR: data },
					stdout: 'pipe',
					stderr: 'pipe'
				});
				expect(await p.exited).toBe(code);
				const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
				expect(out).toContain('Usage: opal');
			}
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60000);
});
