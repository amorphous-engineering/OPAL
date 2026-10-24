import { describe, expect, test } from 'bun:test';
import { mockGithub } from './updater-mock.ts';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	assetName,
	checkForUpdate,
	compareSemver,
	downloadUpdate,
	parseSemver,
	rollbackBinary,
	sha256Hex,
	swapBinary,
	verifyChecksum
} from '../src/supervisor/updater.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'opal-upd-'));

describe('semver', () => {
	test('compare', () => {
		const c = (a: string, b: string) => Math.sign(compareSemver(parseSemver(a)!, parseSemver(b)!));
		expect(c('1.2.3', '1.2.3')).toBe(0);
		expect(c('1.10.0', '1.9.9')).toBe(1);
		expect(c('v2.0.0', '1.99.99')).toBe(1);
		expect(c('1.0.0-rc.1', '1.0.0')).toBe(-1);
		expect(c('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
		expect(c('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
	});
	test('malformed is rejected', () => {
		expect(parseSemver('latest')).toBeNull();
		expect(parseSemver('1.2')).toBeNull();
		expect(parseSemver('')).toBeNull();
	});
});

describe('asset selection', () => {
	test('per platform and arch', () => {
		expect(assetName('darwin', 'arm64')).toBe('opal-macos-arm64');
		expect(assetName('darwin', 'x64')).toBe('opal-macos-x86_64');
		expect(assetName('linux', 'x64')).toBe('opal-linux-x86_64');
		expect(assetName('linux', 'arm64')).toBe('opal-linux-arm64');
		expect(assetName('win32', 'x64')).toBe('opal-windows-x86_64.exe');
	});
	test('unsupported combinations throw', () => {
		expect(() => assetName('win32', 'arm64')).toThrow();
		expect(() => assetName('freebsd', 'x64')).toThrow();
		expect(() => assetName('linux', 'ia32')).toThrow();
	});
});

describe('checksum', () => {
	const data = new TextEncoder().encode('binary');
	const sum = sha256Hex(data);
	test('passes on match, with text or binary marker', () => {
		verifyChecksum(data, `${sum}  opal-linux-x86_64\n`, 'opal-linux-x86_64');
		verifyChecksum(data, `${sum} *opal-linux-x86_64\n`, 'opal-linux-x86_64');
	});
	test('fails on mismatch, missing file and missing entry', () => {
		expect(() => verifyChecksum(data, `${'0'.repeat(64)}  opal-linux-x86_64\n`, 'opal-linux-x86_64')).toThrow(/mismatch/);
		expect(() => verifyChecksum(data, null, 'opal-linux-x86_64')).toThrow(/no SHA256SUMS/);
		expect(() => verifyChecksum(data, `${sum}  other\n`, 'opal-linux-x86_64')).toThrow(/no entry/);
	});
});

describe('check and download against a mock release', () => {
	const common = { platform: 'linux', arch: 'x64', log: () => {} };
	test('newer release is found, older or equal is not', async () => {
		const m = mockGithub({ tag: 'v1.2.0', binary: 'new' });
		const info = await checkForUpdate({ ...common, apiUrl: m.apiUrl, currentVersion: '1.1.9' });
		expect(info?.version).toBe('1.2.0');
		expect(info?.assetName).toBe('opal-linux-x86_64');
		expect(await checkForUpdate({ ...common, apiUrl: m.apiUrl, currentVersion: '1.2.0' })).toBeNull();
		expect(await checkForUpdate({ ...common, apiUrl: m.apiUrl, currentVersion: '2.0.0' })).toBeNull();
	});
	test('malformed tag is ignored with a warning', async () => {
		const m = mockGithub({ tag: 'nightly', binary: 'x' });
		const logs: string[] = [];
		const info = await checkForUpdate({ ...common, apiUrl: m.apiUrl, currentVersion: '1.0.0', log: (s) => logs.push(s) });
		expect(info).toBeNull();
		expect(logs[0]).toMatch(/malformed/);
	});
	test('download verifies and stages the file', async () => {
		const dir = tmp();
		const bin = join(dir, 'opal');
		writeFileSync(bin, 'old');
		const m = mockGithub({ tag: '1.2.0', binary: 'new' });
		const info = (await checkForUpdate({ ...common, apiUrl: m.apiUrl, currentVersion: '1.0.0' }))!;
		const staged = await downloadUpdate(info, bin, common);
		expect(readFileSync(staged, 'utf8')).toBe('new');
	});
	for (const sums of ['bad', 'none', 'missing-entry'] as const) {
		test(`download refuses with sums=${sums} and stages nothing`, async () => {
			const dir = tmp();
			const bin = join(dir, 'opal');
			writeFileSync(bin, 'old');
			const m = mockGithub({ tag: '1.2.0', binary: 'new', sums });
			const info = (await checkForUpdate({ ...common, apiUrl: m.apiUrl, currentVersion: '1.0.0' }))!;
			await expect(downloadUpdate(info, bin, common)).rejects.toThrow();
			expect(existsSync(`${bin}.new`)).toBe(false);
			expect(readFileSync(bin, 'utf8')).toBe('old');
		});
	}
	test('unwritable directory gives a clear error', async () => {
		const dir = tmp();
		const bin = join(dir, 'opal');
		writeFileSync(bin, 'old');
		const m = mockGithub({ tag: '1.2.0', binary: 'new' });
		const info = (await checkForUpdate({ ...common, apiUrl: m.apiUrl, currentVersion: '1.0.0' }))!;
		chmodSync(dir, 0o555);
		try {
			if (process.getuid?.() === 0) return; // root ignores modes
			await expect(downloadUpdate(info, bin, common)).rejects.toThrow(/Cannot write/);
		} finally {
			chmodSync(dir, 0o755);
		}
	});
});

describe('swap and rollback', () => {
	test('swap keeps the old file as .old and makes the new one executable', () => {
		const dir = tmp();
		const bin = join(dir, 'opal');
		writeFileSync(bin, 'old');
		writeFileSync(`${bin}.new`, 'new');
		swapBinary(bin, `${bin}.new`);
		expect(readFileSync(bin, 'utf8')).toBe('new');
		expect(readFileSync(`${bin}.old`, 'utf8')).toBe('old');
		expect(existsSync(`${bin}.new`)).toBe(false);
		if (process.platform !== 'win32') expect(statSync(bin).mode & 0o111).not.toBe(0);
	});
	test('rollback restores the old file', () => {
		const dir = tmp();
		const bin = join(dir, 'opal');
		writeFileSync(bin, 'old');
		writeFileSync(`${bin}.new`, 'new');
		swapBinary(bin, `${bin}.new`);
		expect(rollbackBinary(bin)).toBe(true);
		expect(readFileSync(bin, 'utf8')).toBe('old');
		expect(existsSync(`${bin}.old`)).toBe(false);
		expect(rollbackBinary(bin)).toBe(false);
	});
	test('a failed move restores the original', () => {
		const dir = tmp();
		const bin = join(dir, 'opal');
		writeFileSync(bin, 'old');
		expect(() => swapBinary(bin, join(dir, 'missing'))).toThrow(/Original restored/);
		expect(readFileSync(bin, 'utf8')).toBe('old');
	});
});
