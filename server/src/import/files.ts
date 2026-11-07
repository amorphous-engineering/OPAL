/**
 * Files of a legacy database. The folder comes with the file and is not trusted: a name in a row reads
 * nothing outside it. Nothing here keeps a whole file in memory.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type SourceFile = { path: string; size: number } | { missing: true } | { refused: string };

const inside = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The regular file a row names, if it is one and it is really inside `root`. */
export function sourceFile(root: string, name: unknown): SourceFile {
	if (typeof name !== 'string' || name === '' || name.includes('\0')) return { refused: 'the row has no usable file name' };
	const path = resolve(root, name);
	if (!inside(resolve(root), path)) return { refused: `${JSON.stringify(name)} is outside the attachments folder` };
	let stat;
	let real: string;
	try {
		stat = lstatSync(path);
		if (!stat.isFile()) return { refused: `${JSON.stringify(name)} is not a regular file` };
		real = realpathSync(path);
		// A link in the middle of the path gets past lstat, which only looks at the last part.
		if (!inside(realpathSync(root), real)) return { refused: `${JSON.stringify(name)} leads outside the attachments folder` };
	} catch {
		return { missing: true };
	}
	return { path: real, size: stat.size };
}

const CHUNK = 1 << 20;

function hashOf(path: string): string {
	const hash = createHash('sha256');
	const buf = Buffer.allocUnsafe(CHUNK);
	const fd = openSync(path, 'r');
	try {
		for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) hash.update(buf.subarray(0, n));
	} finally {
		closeSync(fd);
	}
	return hash.digest('hex');
}

export interface Stored {
	sha256: string;
	size: number;
	/** The first bytes, enough to tell an image type. */
	head: Buffer;
}

/**
 * Copies a file into `dir` under its SHA-256. The name only appears once the bytes are all there. A file
 * already under that name stays only if its bytes match: a run that was stopped can have left it short.
 * `created` collects what this call added, so a failed import can take it back.
 */
export function storeByHash(path: string, dir: string, created: string[]): Stored {
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `${randomUUID()}.tmp`);
	const hash = createHash('sha256');
	const buf = Buffer.allocUnsafe(CHUNK);
	let size = 0;
	let head = Buffer.alloc(0);
	const from = openSync(path, 'r');
	try {
		const to = openSync(tmp, 'wx', 0o600);
		try {
			for (let n = readSync(from, buf); n > 0; n = readSync(from, buf)) {
				const part = buf.subarray(0, n);
				hash.update(part);
				for (let at = 0; at < n; ) at += writeSync(to, part, at);
				if (size === 0) head = Buffer.from(part.subarray(0, 16));
				size += n;
			}
			fsyncSync(to);
		} finally {
			closeSync(to);
		}
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	} finally {
		closeSync(from);
	}
	const sha256 = hash.digest('hex');
	const out = join(dir, sha256);
	const had = existsSync(out);
	if (had && hashOf(out) === sha256) rmSync(tmp, { force: true });
	else {
		renameSync(tmp, out);
		if (!had) created.push(out);
	}
	return { sha256, size, head };
}
