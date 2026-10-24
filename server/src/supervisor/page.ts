/** The control page: one self-contained document, no external assets. */
export const CONTROL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OPAL Control</title>
<style>
:root {
	--bg: #ffffff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #d4d4d4; --panel: #f6f6f6;
	--ok: #167a2f; --warn: #946200; --error: #b3261e; --accent: #1d4ed8; --r: 4px;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #121212; --fg: #e6e6e6; --muted: #9a9a9a; --line: #3a3a3a; --panel: #1b1b1b;
		--ok: #4cc26a; --warn: #e5b53c; --error: #f2766d; --accent: #7aa2ff;
	}
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 13px/1.4 system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; }
h1 { font-size: 13px; margin: 0 0 8px; letter-spacing: .08em; text-transform: uppercase; }
.mono, td.v, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: var(--r); }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
th { width: 120px; font-weight: 500; color: var(--muted); background: var(--panel); }
tr:last-child th, tr:last-child td { border-bottom: 0; }
.bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); color: var(--fg); cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { color: var(--muted); cursor: default; }
button.primary { color: var(--accent); }
button.danger { color: var(--error); }
.state-running, .ok { color: var(--ok); }
.state-starting, .warn { color: var(--warn); }
.state-crashed, .error { color: var(--error); }
.state-stopped { color: var(--muted); }
pre { margin: 0; padding: 8px; height: 320px; overflow: auto; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); font-size: 12px; white-space: pre-wrap; word-break: break-all; }
#msg { min-height: 1.4em; margin: 8px 0; }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>OPAL Control</h1>
<table>
<tr><th>State</th><td class="v" id="state">-</td></tr>
<tr><th>Version</th><td class="v" id="version">-</td></tr>
<tr><th>Port</th><td class="v" id="port">-</td></tr>
<tr><th>URL</th><td class="v" id="url">-</td></tr>
<tr><th>Data</th><td class="v" id="data">-</td></tr>
<tr><th>Update</th><td class="v" id="update">-</td></tr>
</table>
<div class="bar">
<button id="start" data-act="start">Start</button>
<button id="stop" data-act="stop">Stop</button>
<button id="restart" data-act="restart">Restart</button>
<button id="open" class="primary">Open OPAL</button>
<button id="check" data-act="check">Check for update</button>
<button id="apply" data-act="update">Update</button>
<button id="quit" class="danger" data-act="quit">Quit</button>
</div>
<div id="msg" class="mono"></div>
<pre id="log"></pre>
</main>
<script>
const key = new URLSearchParams(location.search).get('k') || '';
let status = null;
const $ = (id) => document.getElementById(id);
async function call(path, method) {
	const res = await fetch('/api/' + path, { method, headers: { 'x-opal-key': key } });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
	return body;
}
function msg(text, cls) { const m = $('msg'); m.textContent = text || ''; m.className = 'mono ' + (cls || ''); }
function render(s) {
	status = s;
	const st = $('state'); st.textContent = s.state; st.className = 'v state-' + s.state;
	$('version').textContent = s.version;
	$('port').textContent = s.port;
	$('url').textContent = s.url;
	$('data').textContent = s.dataDir;
	const u = s.update;
	$('update').textContent = u.busy ? u.busy : u.available ? u.available + ' available' : u.checked ? 'current' : '-';
	$('update').className = 'v ' + (u.available ? 'warn' : '');
	const up = s.state === 'running' || s.state === 'starting';
	$('start').disabled = up;
	$('stop').disabled = !up;
	$('open').disabled = s.state !== 'running';
	$('apply').disabled = !u.available || !!u.busy;
	$('check').disabled = !!u.busy;
	if (u.error) msg(u.error, 'error');
	const log = $('log');
	const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
	log.textContent = s.log.join('\\n');
	if (stick) log.scrollTop = log.scrollHeight;
}
async function poll() {
	try { render(await call('status', 'GET')); }
	catch (e) { msg(e.message, 'error'); }
}
document.querySelectorAll('button[data-act]').forEach((b) => {
	b.addEventListener('click', async () => {
		if (b.dataset.act === 'quit' && !confirm('Stop OPAL and quit?')) return;
		msg('');
		try {
			const r = await call(b.dataset.act, 'POST');
			if (r.message) msg(r.message, r.ok === false ? 'error' : 'ok');
			if (b.dataset.act === 'quit') { msg('Quit', 'warn'); return; }
		} catch (e) { msg(e.message, 'error'); }
		poll();
	});
});
$('open').addEventListener('click', () => { if (status) window.open(status.url, '_blank'); });
poll();
setInterval(poll, 1000);
</script>
</body>
</html>
`;
