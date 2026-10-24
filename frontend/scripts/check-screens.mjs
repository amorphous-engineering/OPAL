// Screen check: sign in, visit every path, screenshot each, and report per path the
// console errors, page errors and failed API calls. Exit code 1 when any path has one.
//   node scripts/check-screens.mjs <webPort> <outDir> <user> <password> <path> [path...]
// THEME=light|dark (default dark). Use with a server on an imported seed for real data.
import { chromium } from '@playwright/test';

const [port, out, user, password, ...paths] = process.argv.slice(2);
const base = `http://localhost:${port}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	colorScheme: process.env.THEME === 'light' ? 'light' : 'dark'
});
if (process.env.THEME === 'light')
	await ctx.addInitScript(() => localStorage.setItem('mode-watcher-mode', 'light'));
const page = await ctx.newPage();
let current = [];
page.on('console', (m) => m.type() === 'error' && current.push(`console: ${m.text()}`));
page.on('pageerror', (e) => current.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
	if (r.url().includes('/api/') && r.status() >= 400)
		current.push(`${r.status()} ${r.request().method()} ${r.url().replace(base, '')}`);
});

await page.goto(`${base}/login`);
await page.waitForSelector('#username');
await page.fill('#username', user);
await page.fill('#password', password);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.startsWith('/login'));

let failed = 0;
for (const p of paths) {
	current = [];
	await page.goto(`${base}${p}`);
	await page.waitForLoadState('networkidle');
	const name = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
	await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
	// Values that reached the screen unformatted: a field the page reads but the API no longer sends.
	const text = await page.locator('body').innerText();
	for (const bad of ['undefined', 'NaN', '[object Object]', 'Invalid Date', 'null null'])
		if (text.includes(bad)) current.push(`text: "${bad}" on the page`);
	// A failed console line for a failed request repeats the request line; keep one.
	const problems = current.filter((e) => !e.startsWith('console: Failed to load resource'));
	if (problems.length) failed++;
	console.log(`${problems.length ? 'FAIL' : 'ok  '} ${p}${problems.map((e) => `\n       ${e}`).join('')}`);
}
console.log(`\n${paths.length - failed} of ${paths.length} screens clean`);
await browser.close();
process.exit(failed ? 1 : 0);
