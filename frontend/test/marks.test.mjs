// The Marks block in layout.css styles vendored components by data-slot, and two rules also match a
// variant class. A shadcn update that renames either drops the mark with no error, so check both.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ui = new URL('../src/lib/components/ui/', import.meta.url).pathname;
const css = readFileSync(new URL('../src/routes/layout.css', import.meta.url), 'utf8');
const marks = css.slice(css.indexOf('Marks:'));

const vendored = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? vendored(join(dir, e.name))
			: e.name.endsWith('.svelte')
				? [join(dir, e.name)]
				: []
	);
const source = vendored(ui).map((f) => readFileSync(f, 'utf8'));
// A slot is an attribute (data-slot="input") or a prop default ("data-slot": dataSlot = "input").
const slots = new Set(
	source.flatMap((s) =>
		[...s.matchAll(/data-slot"?(?:=|:\s*\w+\s*=\s*)"([^"]+)"/g)].map((m) => m[1])
	)
);

test('every slot the Marks block styles exists in a vendored component', () => {
	const used = [...marks.matchAll(/\[data-slot='([^']+)'\]/g)].map((m) => m[1]);
	expect(used.length).toBeGreaterThan(0);
	expect(used.filter((s) => !slots.has(s))).toEqual([]);
});

test('every variant class the Marks block matches on a slot is still emitted by that component', () => {
	const pairs = [...marks.matchAll(/\[data-slot='([^']+)'\]\.([\w-]+)/g)].map((m) => [m[1], m[2]]);
	expect(pairs.length).toBeGreaterThan(0);
	const missing = pairs.filter(([slot, cls]) => {
		const owner = source.filter((s) => s.includes(`data-slot="${slot}"`));
		return !owner.some((s) => new RegExp(`["\\s]${cls}["\\s]`).test(s));
	});
	expect(missing).toEqual([]);
});
