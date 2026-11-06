import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { contracts } from './contracts.ts';
import { LIMITED_JSON, MAX_JSON_TEXT, MAX_MARKDOWN, MAX_SHORT, MAX_TEXT, zJsonObject } from './limits.ts';

type Node = { _zod: { def: Record<string, unknown> } };

/** Every string an operation accepts, with where it sits. */
function strings(s: unknown, path: string, out: { path: string; s: z.ZodString }[], seen = new Set<unknown>()): void {
	const node = s as Node | undefined;
	if (!node?._zod) return;
	const def = node._zod.def as Record<string, any>;
	if (def.type === 'string') {
		out.push({ path, s: s as z.ZodString });
		return;
	}
	if (seen.has(s)) return;
	seen.add(s);
	switch (def.type) {
		case 'object':
			for (const [k, v] of Object.entries(def.shape)) strings(v, `${path}.${k}`, out, seen);
			break;
		case 'array':
			strings(def.element, `${path}[]`, out, seen);
			break;
		case 'optional':
		case 'nullable':
		case 'default':
		case 'prefault':
		case 'readonly':
		case 'catch':
		case 'nonoptional':
			strings(def.innerType, path, out, seen);
			break;
		case 'union':
			for (const o of def.options) strings(o, path, out, seen);
			break;
		case 'record':
			strings(def.keyType, `${path}{key}`, out, seen);
			strings(def.valueType, `${path}{}`, out, seen);
			break;
		case 'pipe':
			strings(def.in, path, out, seen);
			strings(def.out, path, out, seen);
			break;
		case 'tuple':
			for (const i of def.items) strings(i, `${path}[]`, out, seen);
			break;
		case 'intersection':
			strings(def.left, path, out, seen);
			strings(def.right, path, out, seen);
			break;
	}
}

function operations(node: Record<string, any>, prefix = ''): { name: string; input: z.ZodType }[] {
	return Object.entries(node).flatMap(([k, v]) =>
		v?.input && v?.output ? [{ name: `${prefix}${k}`, input: v.input as z.ZodType }] : v && typeof v === 'object' ? operations(v, `${prefix}${k}.`) : []
	);
}

/** Strings with no length limit of their own. Each is bounded by its pattern or owned elsewhere. */
const UNLIMITED_BUT_BOUNDED = new Set([
	// A YYYY-MM-DD pattern, anchored: 10 characters.
	'inventory.create.expirationDate',
	'inventory.correct.expirationDate',
	'purchasing.orders.list.targetFrom',
	'purchasing.orders.list.targetTo',
	'purchasing.orders.create.targetDate',
	'purchasing.orders.update.targetDate',
	// A 40-character hex digest or the word `local`, anchored.
	'plugins.install.sha'
]);

function operationsWithOutput(node: Record<string, any>, prefix = ''): { name: string; output: z.ZodType }[] {
	return Object.entries(node).flatMap(([k, v]) =>
		v?.input && v?.output
			? [{ name: `${prefix}${k}`, output: v.output as z.ZodType }]
			: v && typeof v === 'object'
				? operationsWithOutput(v, `${prefix}${k}.`)
				: []
	);
}

/** Free-form values an operation accepts with no size cap around them. */
function openJson(s: unknown, path: string, out: string[], seen = new Set<unknown>()): void {
	const node = s as Node | undefined;
	if (!node?._zod || LIMITED_JSON.has(node as object) || seen.has(s)) return;
	seen.add(s);
	const def = node._zod.def as Record<string, any>;
	if (def.type === 'unknown' || def.type === 'any') out.push(path);
	if (def.type === 'object') for (const [k, v] of Object.entries(def.shape)) openJson(v, `${path}.${k}`, out, seen);
	for (const key of ['element', 'innerType', 'valueType', 'in', 'out', 'left', 'right']) if (def[key]) openJson(def[key], path, out, seen);
	for (const key of ['options', 'items']) for (const o of def[key] ?? []) openJson(o, path, out, seen);
}

describe('free-form input', () => {
	test('every free-form value an operation accepts sits inside a size cap, so one request cannot store megabytes there', () => {
		const open: string[] = [];
		for (const op of operations(contracts as Record<string, any>)) openJson(op.input, op.name, open);
		expect(open).toEqual([]);
	});

	test('the cap counts the whole value', () => {
		const s = zJsonObject();
		expect(s.safeParse({ note: 'x'.repeat(100) }).success).toBe(true);
		expect(s.safeParse({ note: 'x'.repeat(MAX_JSON_TEXT + 1) }).success).toBe(false);
	});
});

describe('output checks', () => {
	test('no output has a length limit, so a value the server accepted earlier always reads', () => {
		const limited: string[] = [];
		for (const op of operationsWithOutput(contracts as Record<string, any>)) {
			const found: { path: string; s: z.ZodString }[] = [];
			strings(op.output, '', found);
			for (const { path, s } of found) if (s.maxLength != null) limited.push(`${op.name}${path}`);
		}
		expect(limited).toEqual([]);
	});

	test('input still has its limits', () => {
		const s = contracts.parts.create.input as z.ZodType;
		expect(s.safeParse({ name: 'x'.repeat(100_000) }).success).toBe(false);
	});
});

describe('input limits', () => {
	test('every text an operation accepts has a length limit', () => {
		const unlimited: string[] = [];
		for (const op of operations(contracts as Record<string, any>)) {
			const found: { path: string; s: z.ZodString }[] = [];
			strings(op.input, '', found);
			for (const { path, s } of found) {
				if (s.maxLength == null) unlimited.push(`${op.name}${path}`);
			}
		}
		const unexpected = unlimited.filter((u) => !UNLIMITED_BUT_BOUNDED.has(u) && !u.startsWith('org.users.uploadAvatar'));
		expect(unexpected).toEqual([]);
	});

	test('the limits leave room for real writing and stay far below a request that stalls the server', () => {
		expect(MAX_SHORT).toBeGreaterThanOrEqual(255);
		// The longest text in the demo data is 1,330 characters.
		expect(MAX_TEXT).toBeGreaterThanOrEqual(4_000);
		expect(MAX_MARKDOWN).toBeGreaterThanOrEqual(64_000);
		expect(MAX_MARKDOWN).toBeLessThanOrEqual(1_000_000);
	});
});
