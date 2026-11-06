// Page security check: every screen loads under the page policy with no violation, and another
// origin cannot frame the app.
//   node scripts/check-headers.mjs <port> <user> <password>
// Use with a server on an imported seed (see CLAUDE.md, Tests). Exits 1 on any violation or if a
// foreign page can frame the app.
import { chromium } from '@playwright/test';
import http from 'node:http';

const [port, user, password] = process.argv.slice(2);
const base = `http://localhost:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const problems = [];
let where = '';
page.on('console', (m) => {
	if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`${where}: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`${where}: page error ${e.message}`));
await page.addInitScript(() => {
	document.addEventListener('securitypolicyviolation', (e) =>
		console.error(`Refused to (event) ${e.violatedDirective} ${e.blockedURI}`)
	);
});

where = '/login';
const first = await page.goto(`${base}/login`);
const h = first.headers();
for (const k of [
	'content-security-policy',
	'x-frame-options',
	'x-content-type-options',
	'referrer-policy'
]) {
	if (!h[k]) problems.push(`/login has no ${k}`);
}
console.log('content-security-policy:', h['content-security-policy']);
await page.waitForSelector('#username');
await page.fill('#username', user);
await page.fill('#password', password);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.startsWith('/login'));

const list = async (path) => {
	const j = await (await page.request.get(`${base}/api${path}`)).json();
	return Array.isArray(j) ? j : (j.items ?? []);
};
const issues = await list('/issues?limit=100');
const procs = await list('/procedures?limit=100');
const execs = await list('/executions?limit=100');
const parts = await list('/parts?limit=20');
const pos = await list('/purchases?limit=20');

const paths = [
	'/',
	'/parts',
	parts[0] && `/parts/${parts[0].id}`,
	'/inventory',
	'/procedures',
	procs[0] && `/procedures/${procs[0].id}`,
	'/executions',
	execs[0] && `/executions/${execs[0].id}`,
	execs[0] && `/executions/${execs[0].id}/report`,
	'/issues',
	issues[0] && `/issues/${issues[0].id}`,
	'/risks',
	'/requirements',
	'/purchases',
	pos[0] && `/purchases/${pos[0].id}`,
	'/settings',
	'/settings/plugins',
	'/settings/users',
	parts[0] && `/label?part=${parts[0].id}`,
	'/oauth/authorize?response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcb&code_challenge=x&code_challenge_method=S256'
].filter(Boolean);

// A published version's print page.
for (const p of procs.slice(0, 5)) {
	const versions = await list(`/procedures/${p.id}/versions`).catch(() => []);
	const v = versions[0];
	if (v) {
		paths.push(`/procedures/${p.id}/versions/${v.id}/print`);
		break;
	}
}

for (const path of paths) {
	where = path;
	await page.goto(`${base}${path}`);
	await page.waitForLoadState('networkidle').catch(() => {});
	await page.waitForTimeout(500);
	const body = (
		await page
			.locator('body')
			.innerText()
			.catch(() => '')
	).trim();
	console.log(body.length > 20 ? 'ok   ' : 'EMPTY', path);
	if (path.startsWith('/label?')) {
		// The QR is a data: image.
		const qr = await page.$$eval('img', (i) => i.filter((x) => x.naturalWidth > 0).length);
		console.log(qr ? 'ok   ' : 'EMPTY', 'label QR images drawn:', qr);
		if (!qr) problems.push('label QR not drawn');
	}
}

// Another origin frames the app. Same host, other port, as a hostile page on the network would.
// Run twice: with the headers as served (must be blocked), then with the framing headers
// stripped in flight (must load), which shows this check can tell the two apart.
where = 'framing';
const srv = http.createServer((q, r) => {
	r.setHeader('content-type', 'text/html');
	r.end(`<iframe id=f src="${base}/settings" width=900 height=600></iframe>`);
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const framedText = async (strip) => {
	const fr = await ctx.newPage();
	if (strip) {
		await fr.route(`${base}/settings`, async (route) => {
			const res = await route.fetch();
			const headers = { ...res.headers() };
			delete headers['x-frame-options'];
			delete headers['content-security-policy'];
			await route.fulfill({ response: res, headers });
		});
	}
	await fr.goto(`http://localhost:${srv.address().port}/`);
	await fr.waitForTimeout(2500);
	const inner = fr.frames().find((f) => f !== fr.mainFrame());
	let text = '';
	try {
		text = (await inner.locator('body').innerText({ timeout: 4000 })).trim();
	} catch {
		/* a blocked frame has no readable body */
	}
	await fr.close();
	return text;
};
const blocked = await framedText(false);
const control = await framedText(true);
console.log('framed as served:', JSON.stringify(blocked.slice(0, 60)));
console.log('framed with headers stripped (control):', JSON.stringify(control.slice(0, 60)));
if (blocked.length > 40) problems.push('another origin could frame /settings');
if (control.length <= 40) problems.push('framing control did not load: this check proves nothing');
srv.close();

await browser.close();
if (problems.length) {
	console.log('\nPROBLEMS');
	for (const p of new Set(problems)) console.log(' ', p);
	process.exit(1);
}
console.log('\nno violations');
