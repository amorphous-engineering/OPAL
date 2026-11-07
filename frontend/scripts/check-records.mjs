// Records check: open committed records as a reader and fail if the page greets them with editors.
//   node scripts/check-records.mjs <webPort> <user> <password>
// Use with a server on an imported seed (see CLAUDE.md, Tests). The rule lives in CLAUDE.md, Records:
// pages open for reading, and the only inputs on open are the blank the state is waiting on.
import { chromium } from '@playwright/test';

const [port, user, password] = process.argv.slice(2);
const base = `http://localhost:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	colorScheme: 'dark'
});
const page = await ctx.newPage();
await page.goto(`${base}/login`);
await page.waitForSelector('#username');
await page.fill('#username', user);
await page.fill('#password', password);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.startsWith('/login'));

const list = async (path) => {
	const r = await page.request.get(`${base}/api${path}`);
	const j = await r.json();
	return Array.isArray(j) ? j : (j.items ?? []);
};
const issues = await list('/issues?limit=100');
const risks = await list('/risks?limit=100');
const reqs = await list('/requirements?limit=200');
const pos = await list('/purchases?limit=100');
const procs = await list('/procedures?limit=100');
const execs = await list('/executions?limit=100');
const parts = await list('/parts?limit=100&state=active');
const stock = await list('/inventory?limit=100&view=records');

const issue = (n) => issues.find((i) => i.issueNumber === n)?.id;
const po = (s) => pos.find((p) => p.status === s)?.id;
const exec = (s) => execs.find((e) => e.status === s)?.id;

// `fields` is what this state legitimately asks for on open. Anything above it fails.
const pages = [
	['held issue', `/issues/${issue('IT-0001')}`, { fields: 1, note: 'comment line' }],
	['done issue', `/issues/${issues.find((i) => i.status === 'closed')?.id}`, { fields: 1, note: 'comment line', edit: 0 }],
	['accepted risk', `/risks/${risks.find((r) => r.acceptedAt)?.id}`, { fields: 0 }],
	[
		'baselined requirement',
		`/requirements/${reqs.find((r) => r.lifecycleState === 'baselined')?.id}`,
		{ fields: 0, edit: 0 }
	],
	[
		'draft requirement',
		`/requirements/${reqs.find((r) => r.lifecycleState === 'draft')?.id}`,
		{ fields: 0 }
	],
	[
		'partial purchase order',
		`/purchases/${po('partial')}`,
		{ fields: 10, note: 'receive rows, attachment kind' }
	],
	[
		'received purchase order',
		`/purchases/${po('received')}`,
		{ fields: 1, note: 'attachment kind' }
	],
	['active part', `/parts/${parts[0]?.id}`, { fields: 0 }],
	[
		'stock record',
		`/inventory/opal/${stock.find((s) => Number(s.balance) > 0)?.opalNumber}`,
		{ fields: 0, edit: 0 }
	],
	[
		'released template',
		`/procedures/${procs.find((p) => p.status === 'released')?.id}`,
		{ fields: 0, wait: 2000 }
	],
	[
		'work order in work',
		`/executions/${exec('in_work')}`,
		{ fields: 4, note: 'capture fields, notes box, comment', wait: 2000 }
	],
	[
		'completed work order',
		`/executions/${exec('completed')}`,
		{ fields: 1, note: 'comment', edit: 0, wait: 2000 }
	]
];

const census = () => {
	const visible = (e) => {
		const r = e.getBoundingClientRect();
		const s = getComputedStyle(e);
		return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
	};
	const outside = (e) =>
		!e.closest('nav, [role=navigation], [role=dialog], footer, [data-sidebar]');
	const fields = [
		...document.querySelectorAll(
			'input:not([type=hidden]), select, textarea, [contenteditable=true]'
		)
	]
		.filter(visible)
		.filter(outside)
		.filter((e) => !/search/i.test(e.placeholder ?? '') && e.type !== 'search');
	const clickable = [...document.querySelectorAll('button, a')].filter(visible).filter(outside);
	return {
		fields: fields.length,
		edits: clickable.filter((e) => /^(EDIT|EDIT DRAFT)$/.test((e.innerText ?? '').trim())).length,
		red: clickable
			.filter((e) => /bg-destructive|text-destructive/.test(e.className?.toString() ?? ''))
			.map((e) => e.innerText.trim())
	};
};

let failed = 0;
for (const [name, path, want] of pages) {
	if (path.includes('undefined')) {
		console.log(`SKIP  ${name}: the seed has no such record`);
		continue;
	}
	await page.goto(`${base}${path}`);
	await page.waitForTimeout(want.wait ?? 1200);
	const got = await page.evaluate(census);
	const problems = [];
	if (got.fields > want.fields)
		problems.push(`${got.fields} inputs, allowed ${want.fields} (${want.note ?? 'none'})`);
	const edits = want.edit ?? 1;
	if (got.edits > edits) problems.push(`${got.edits} EDIT controls, allowed ${edits}`);
	if (got.red.length) problems.push(`red controls on open: ${got.red.join(', ')}`);
	if (problems.length) failed++;
	console.log(
		`${problems.length ? 'FAIL' : 'ok  '}  ${name}${problems.length ? ': ' + problems.join('; ') : ''}`
	);
}
await browser.close();
if (failed) {
	console.log(`\n${failed} page(s) greet a reader with editors. See Records in CLAUDE.md.`);
	process.exit(1);
}
