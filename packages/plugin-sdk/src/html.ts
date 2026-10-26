const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: unknown): string {
	return String(s).replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** Marks text that is already safe HTML, so `html` does not escape it again. */
export class SafeHtml {
	constructor(readonly value: string) {}
	toString(): string {
		return this.value;
	}
}

export const raw = (s: string) => new SafeHtml(s);

function part(v: unknown): string {
	if (v instanceof SafeHtml) return v.value;
	if (Array.isArray(v)) return v.map(part).join('');
	if (v === null || v === undefined || v === false) return '';
	return escapeHtml(v);
}

/** Tagged template. Interpolations are escaped; nested `html` results and arrays of them are not. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
	let out = strings[0]!;
	values.forEach((v, i) => {
		out += part(v) + strings[i + 1]!;
	});
	return new SafeHtml(out);
}
