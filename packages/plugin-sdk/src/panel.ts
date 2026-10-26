import { escapeHtml, SafeHtml } from './html.ts';

// Tokens match frontend/src/routes/layout.css. Keep both in step.
const CSS = `
:root{--background:oklch(1 0 0);--foreground:oklch(0.145 0 0);--card:oklch(1 0 0);--primary:oklch(0.546 0.245 262.881);--primary-foreground:oklch(0.985 0 0);--muted:oklch(0.97 0 0);--muted-foreground:oklch(0.45 0 0);--border:oklch(0.922 0 0);--input:oklch(0.922 0 0);--ok:oklch(0.448 0.119 151.328);--warn:oklch(0.473 0.137 46.201);--error:oklch(0.505 0.213 27.518);--info:oklch(0.488 0.243 264.376);--radius:4px;color-scheme:light}
:root[data-theme=dark]{--background:#0a0a0a;--foreground:#e0e0e0;--card:#141414;--primary:#4a9eff;--primary-foreground:#0a0a0a;--muted:#1e1e1e;--muted-foreground:#a3a3a3;--border:#333;--input:#444;--ok:#4ade80;--warn:#fbbf24;--error:#f87171;--info:#4a9eff;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{font:13px/1.4 'IBM Plex Sans Variable','IBM Plex Sans',ui-sans-serif,system-ui,sans-serif;color:var(--foreground);padding:8px}
h1,h2,h3{font-size:13px;font-weight:600;margin:0 0 6px}
p{margin:0 0 6px}
a{color:var(--primary)}
code,.mono{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12px}
.muted{color:var(--muted-foreground)}
table{width:100%;border-collapse:collapse;margin:0 0 8px}
th,td{text-align:left;padding:3px 8px;border-bottom:1px solid var(--border);vertical-align:top}
th{font-weight:500;color:var(--muted-foreground);font-size:12px}
.badge{display:inline-block;padding:0 6px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;line-height:18px;background:var(--muted)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.badge.error{color:var(--error);border-color:var(--error)}
.badge.info{color:var(--info);border-color:var(--info)}
button,.button{font:inherit;padding:2px 10px;border:1px solid var(--input);border-radius:var(--radius);background:var(--card);color:var(--foreground);cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.button:hover{background:var(--muted)}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{font:inherit;padding:2px 6px;border:1px solid var(--input);border-radius:var(--radius);background:var(--card);color:var(--foreground)}
`;

// Runs in the sandboxed iframe: no same-origin, so it talks to its plugin through the proxy with the panel token.
const SCRIPT = `
(function(){
var q=new URLSearchParams(location.search);
var params={};q.forEach(function(v,k){params[k]=v});
var pt=q.get('pt')||'';
var id=PLUGIN_ID;
window.opal={params:params,fetch:function(path,init){
init=init||{};var h=new Headers(init.headers||{});h.set('X-Opal-Panel',pt);
var p=String(path);if(p[0]!=='/')p='/'+p;
return fetch('/plugins/'+encodeURIComponent(id)+p,Object.assign({},init,{headers:h}));}};
var last=-1;
function post(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);
if(h===last)return;last=h;parent.postMessage({type:'opal-panel-height',height:h},'*');}
addEventListener('load',post);addEventListener('resize',post);
if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);
post();
})();
`;

export interface PanelPageOptions {
	title: string;
	body: SafeHtml | string;
	/** `light` or `dark`; anything else means light. Read it from the `theme` query param. */
	theme?: string | null;
	/** Plugin id, so `window.opal.fetch` can build the proxy path. Defaults to OPAL_PLUGIN_ID. */
	pluginId?: string;
}

/** A full HTML document for a panel iframe. `body` is trusted HTML: build it with `html`. */
export function panelPage(opts: PanelPageOptions): string {
	const theme = opts.theme === 'dark' ? 'dark' : 'light';
	const id = opts.pluginId ?? process.env.OPAL_PLUGIN_ID ?? '';
	// JSON in a script tag: "<" is escaped so the id cannot close the tag.
	const idJs = JSON.stringify(id).replace(/</g, '\\u003c');
	return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
${String(opts.body)}
<script>${SCRIPT.replace('PLUGIN_ID', idJs)}</script>
</body>
</html>
`;
}
