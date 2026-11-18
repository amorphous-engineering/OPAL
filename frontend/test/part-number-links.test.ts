import { describe, expect, test } from 'bun:test';
import { Marked } from 'marked';
import { partNumberLinks } from '../src/lib/partNumberLinks.ts';

function renderer() {
	const links = partNumberLinks();
	const md = new Marked({ gfm: true, breaks: true });
	md.use({ extensions: [links.extension] });
	return (text: string, known: string[]) =>
		links.using(known, () => md.parse(text, { async: false }) as string).trim();
}

const link = (pn: string) => `<a href="/parts/number/${encodeURIComponent(pn)}">${pn}</a>`;

describe('part numbers in step text', () => {
	const render = renderer();

	test('a number that names a part links to it by number', () => {
		expect(render('Fit SPX-F-0132 to the frame.', ['SPX-F-0132'])).toBe(
			`<p>Fit ${link('SPX-F-0132')} to the frame.</p>`
		);
	});

	test('a number the server did not name stays plain text', () => {
		expect(render('Fit SPX-F-0132 and SPX-F-0133.', ['SPX-F-0132'])).toBe(
			`<p>Fit ${link('SPX-F-0132')} and SPX-F-0133.</p>`
		);
		expect(render('Fit SPX-F-0132.', [])).toBe('<p>Fit SPX-F-0132.</p>');
	});

	test('every place the number is written links, inside formatting too', () => {
		expect(render('**SPX-F-0132**, then (SPX-F-0132)', ['SPX-F-0132'])).toBe(
			`<p><strong>${link('SPX-F-0132')}</strong>, then (${link('SPX-F-0132')})</p>`
		);
		expect(render('- SPX-F-0132\n- x', ['SPX-F-0132'])).toContain(`<li>${link('SPX-F-0132')}</li>`);
	});

	test('a variant wins over its base', () => {
		expect(render('SPX-F-0132-002 and SPX-F-0132', ['SPX-F-0132', 'SPX-F-0132-002'])).toBe(
			`<p>${link('SPX-F-0132-002')} and ${link('SPX-F-0132')}</p>`
		);
	});

	test('the same characters running into a word are not the number', () => {
		for (const text of [
			'XSPX-F-0132',
			'A-SPX-F-0132',
			'SPX-F-0132A',
			'SPX-F-0132-02',
			'SPX-F-0132.5',
			'a_SPX-F-0132'
		]) {
			expect(render(text, ['SPX-F-0132'])).toBe(`<p>${text}</p>`);
		}
	});

	test('code and existing links are left as written', () => {
		expect(render('`SPX-F-0132`', ['SPX-F-0132'])).toBe('<p><code>SPX-F-0132</code></p>');
		expect(render('```\nSPX-F-0132\n```', ['SPX-F-0132'])).toBe(
			'<pre><code>SPX-F-0132\n</code></pre>'
		);
		expect(render('[SPX-F-0132](/elsewhere)', ['SPX-F-0132'])).toBe(
			'<p><a href="/elsewhere">SPX-F-0132</a></p>'
		);
		expect(render('See https://x.local/SPX-F-0132 now', ['SPX-F-0132'])).toBe(
			'<p>See <a href="https://x.local/SPX-F-0132">https://x.local/SPX-F-0132</a> now</p>'
		);
	});

	test('a number with characters a URL or HTML would read is escaped', () => {
		expect(render('Fit RV.1.F.0042/002 now', ['RV.1.F.0042/002'])).toBe(
			'<p>Fit <a href="/parts/number/RV.1.F.0042%2F002">RV.1.F.0042/002</a> now</p>'
		);
		expect(render('A&B-0001 here', ['A&B-0001'])).toBe(
			'<p><a href="/parts/number/A%26B-0001">A&#38;B-0001</a> here</p>'
		);
	});

	test('nothing is linked once the render is over', () => {
		render('SPX-F-0132', ['SPX-F-0132']);
		const md = new Marked();
		expect(md.parse('SPX-F-0132', { async: false })).toBe('<p>SPX-F-0132</p>\n');
	});
});
