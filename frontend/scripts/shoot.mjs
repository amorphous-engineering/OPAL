// Interactive smoke: sign in as a demo user, visit paths, screenshot each, report console errors.
//   node scripts/shoot.mjs <webPort> <outDir> <path> [path...]   (env THEME=dark for dark mode)
import { chromium } from '@playwright/test';
const [port, out, ...paths] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	colorScheme: process.env.THEME === 'dark' ? 'dark' : 'light'
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on(
	'response',
	(r) =>
		r.url().includes('/api/') &&
		r.status() >= 400 &&
		errors.push(`[${r.status()}] ${r.request().method()} ${r.url().replace(base, '')}`)
);
await page.goto(`${base}/login`);
await page.waitForSelector('#username');
await page.screenshot({ path: `${out}/login.png` });
await page.fill('#username', process.env.OPAL_USER ?? 'build');
await page.fill('#password', process.env.OPAL_PASS ?? 'kestrel-demo');
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.startsWith('/login'));
for (const p of paths) {
	await page.goto(`${base}${p}`);
	await page.waitForLoadState('networkidle');
	const name = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
	await page.screenshot({ path: `${out}/${name}.png`, fullPage: process.env.FULL !== '0' });
	console.log(`shot ${p} -> ${out}/${name}.png`);
}
console.log(errors.length ? errors.join('\n') : 'no errors');
await browser.close();
