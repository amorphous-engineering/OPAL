/**
 * A small tar.gz reader for GitHub tarballs. It writes regular files and
 * directories only, and refuses anything that could write outside the target.
 */
import { OpalError } from '@opal/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 5000;

const bad = (msg: string) => new OpalError(422, 'invalid_archive', msg);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const cstr = (b: Uint8Array) => {
	const end = b.indexOf(0);
	return text(end < 0 ? b : b.subarray(0, end));
};

function octal(b: Uint8Array): number {
	// Base-256 sizes (first bit set) appear for entries over 8 GB: far over our cap.
	if (b[0]! & 0x80) throw bad('The archive has an entry that is too large');
	const s = cstr(b).trim();
	return s ? parseInt(s, 8) : 0;
}

/** `len key=value\n` records of a pax header. */
function paxRecords(data: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	let i = 0;
	while (i < data.length) {
		const sp = data.indexOf(0x20, i);
		if (sp < 0) break;
		const len = parseInt(text(data.subarray(i, sp)), 10);
		if (!Number.isFinite(len) || len <= 0) break;
		const rec = text(data.subarray(sp + 1, i + len - 1));
		const eq = rec.indexOf('=');
		if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
		i += len;
	}
	return out;
}

/** Path below the first component, or null for the top folder itself. Throws on unsafe paths. */
function safeRelative(raw: string): string | null {
	if (raw.includes('\0')) throw bad(`Unsafe path in the archive: ${JSON.stringify(raw)}`);
	if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw bad(`Absolute path in the archive: ${raw}`);
	const parts = raw.split(/[\\/]/);
	if (parts.includes('..')) throw bad(`Path with .. in the archive: ${raw}`);
	const rest = parts.slice(1).filter((p) => p && p !== '.');
	return rest.length ? rest.join('/') : null;
}

export function extractTarGz(data: Uint8Array, dest: string): { files: number; bytes: number } {
	let tar: Uint8Array;
	try {
		tar = gunzipSync(data, { maxOutputLength: MAX_TOTAL_BYTES * 2 });
	} catch {
		throw bad('The download is not a gzip archive, or it is too large');
	}
	const root = resolve(dest);
	mkdirSync(root, { recursive: true });
	let files = 0;
	let bytes = 0;
	let longName: string | null = null;
	let pax: Record<string, string> = {};
	let off = 0;
	while (off + 512 <= tar.length) {
		const h = tar.subarray(off, off + 512);
		if (h.every((x) => x === 0)) break;
		let name = cstr(h.subarray(0, 100));
		const magic = text(h.subarray(257, 262));
		const prefix = magic === 'ustar' ? cstr(h.subarray(345, 500)) : '';
		if (prefix) name = `${prefix}/${name}`;
		let size = octal(h.subarray(124, 136));
		const type = String.fromCharCode(h[156] || 0x30);
		off += 512;
		if (pax.size && !'xgLK'.includes(type)) size = parseInt(pax.size, 10);
		const padded = Math.ceil(size / 512) * 512;
		if (off + size > tar.length) throw bad('The archive is cut short');
		const body = tar.subarray(off, off + size);
		off += padded;

		if (type === 'g') continue; // global pax header: GitHub puts the commit id here
		if (type === 'x') {
			pax = paxRecords(body);
			continue;
		}
		if (type === 'L') {
			longName = cstr(body);
			continue;
		}
		if (type === 'K') continue;
		if (pax.path) name = pax.path;
		else if (longName !== null) name = longName;
		pax = {};
		longName = null;

		if (type === '1' || type === '2') throw bad(`Links are not allowed in a plugin: ${name}`);
		if (type !== '0' && type !== '5') throw bad(`Unsupported entry type in the archive: ${name}`);
		const rel = safeRelative(name);
		if (rel === null) continue;
		const target = resolve(root, rel);
		if (!target.startsWith(root + sep)) throw bad(`Path leaves the plugin folder: ${name}`);
		if (type === '5') {
			mkdirSync(target, { recursive: true });
			continue;
		}
		files++;
		bytes += size;
		if (files > MAX_FILES) throw bad(`The archive has more than ${MAX_FILES} files`);
		if (bytes > MAX_TOTAL_BYTES) throw bad(`The archive is larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, body);
	}
	return { files, bytes };
}

