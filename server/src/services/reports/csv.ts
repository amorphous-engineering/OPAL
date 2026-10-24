/** CSV text. Same dialect as the Python csv module: CRLF rows, quotes only where needed. */

export type Cell = string | number | boolean | null | undefined;

const NUMBER = /^-?\d+(\.\d+)?$/;

function cell(v: Cell): string {
	if (v === null || v === undefined) return '';
	let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
	// A spreadsheet runs a cell that starts with = + - @ as a formula. Numbers are fine.
	if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: Iterable<readonly Cell[]>): string {
	const lines = [header.map(cell).join(',')];
	for (const r of rows) lines.push(r.map(cell).join(','));
	return `${lines.join('\r\n')}\r\n`;
}

/** First `n` characters, as the legacy export cut long descriptions. */
export const clip = (s: string | null | undefined, n: number): string => (s ?? '').slice(0, n);
