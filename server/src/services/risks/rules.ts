/**
 * Loads lint_rules.yaml as data. The file is embedded as text (Bun inlines it into the binary).
 * The reader below handles exactly the shape that file uses: a `rules:` list of mappings with
 * scalar values, one `>` folded scalar, and `terms:` lists. Anything else throws.
 */
import rulesText from './lint_rules.yaml' with { type: 'text' };

export interface LintRule {
	id: string;
	name: string;
	description: string;
	severity: 'warn' | 'block_accept';
	source: string;
	terms: string[];
}

const unquote = (v: string) => v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

export function parseRules(text: string): LintRule[] {
	const lines = text.split('\n');
	const rules: Record<string, unknown>[] = [];
	let cur: Record<string, unknown> | null = null;
	let list: string[] | null = null;
	let folded: string | null = null;
	let seenRules = false;
	for (const raw of lines) {
		if (/^\s*(#.*)?$/.test(raw)) continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();
		if (folded && indent > 4) {
			cur![folded] = `${cur![folded] ? `${cur![folded]} ` : ''}${line}`;
			continue;
		}
		folded = null;
		if (indent === 0) {
			if (line !== 'rules:') throw new Error(`lint_rules.yaml: unexpected "${line}"`);
			seenRules = true;
			continue;
		}
		if (!seenRules) throw new Error('lint_rules.yaml: content before rules:');
		if (line.startsWith('- ') && list && indent >= 6) {
			list.push(unquote(line.slice(2).trim()));
			continue;
		}
		let body = line;
		if (line.startsWith('- ') && indent === 2) {
			cur = {};
			rules.push(cur);
			body = line.slice(2).trim();
		}
		const m = /^([A-Za-z_]+):\s*(.*)$/.exec(body);
		if (!m || !cur) throw new Error(`lint_rules.yaml: cannot read "${line}"`);
		const [, key, value] = m as unknown as [string, string, string];
		list = null;
		if (value === '>') {
			folded = key;
			cur[key] = '';
		} else if (value === '') {
			list = [];
			cur[key] = list;
		} else cur[key] = unquote(value);
	}
	return rules.map((r) => ({ terms: [], ...r }) as unknown as LintRule);
}

export const RULES: Record<string, LintRule> = Object.fromEntries(
	parseRules(rulesText).map((r) => [r.name, r])
);
