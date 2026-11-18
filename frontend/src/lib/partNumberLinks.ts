/**
 * Part numbers in rendered markdown become links to the part. The caller says which strings are
 * part numbers (the server reads them; the UI never parses a number), so an unknown number stays
 * plain text. The link goes by number, not row id, so it names the same part wherever the text is
 * read. Never inside a link or code.
 */
import type { TokenizerAndRendererExtension, Tokens } from 'marked';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Not after a word or hyphen, and not running on into a word (`F-0132A`, `F-0132-02`, `F-0132.5`).
const BEFORE = /[\w-]/;
const AFTER = '(?!\\w|[^\\s\\w]\\w)';

export const partHref = (pn: string) => `/parts/number/${encodeURIComponent(pn)}`;

export function partNumberLinks() {
	let current: { any: RegExp; here: RegExp } | null = null;

	const extension: TokenizerAndRendererExtension = {
		name: 'partNumber',
		level: 'inline',
		start(src) {
			if (!current) return;
			for (const m of src.matchAll(current.any)) {
				if (!BEFORE.test(src[m.index - 1] ?? '')) return m.index;
			}
		},
		tokenizer(src, tokens) {
			if (!current || this.lexer.state.inLink) return;
			current.here.lastIndex = 0;
			const m = current.here.exec(src);
			if (!m || BEFORE.test(tokens.at(-1)?.raw.at(-1) ?? '')) return;
			return { type: 'partNumber', raw: m[0], text: m[0] };
		},
		renderer(token: Tokens.Generic) {
			const text = String(token.text);
			return `<a href="${partHref(text)}">${escapeHtml(text)}</a>`;
		}
	};

	/** Run `render` with these strings linked. Longest first, so a variant wins over its base. */
	function using<T>(numbers: readonly string[], render: () => T): T {
		const known = [...numbers].sort((a, b) => b.length - a.length);
		const re = `(?:${known.map(escapeRe).join('|')})${AFTER}`;
		current = known.length ? { any: new RegExp(re, 'g'), here: new RegExp(re, 'y') } : null;
		try {
			return render();
		} finally {
			current = null;
		}
	}

	return { extension, using };
}
