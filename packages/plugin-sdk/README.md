# @opal/plugin-sdk

A plugin is one program that OPAL starts and stops. It reads OPAL data through the API.
It can show panels in OPAL pages and receive webhooks.

## Files

A plugin repository has these files:

- `manifest.json`: the id, name, version, `main`, permissions, settings and panels.
- `src/plugin.ts`: the source.
- `dist/plugin.js`: the bundle. `main` in the manifest names this file.

Commit `dist/`. OPAL installs the repository as it is and does not build it.

## Write a plugin

```ts
import { definePlugin, html, panelPage, userOf, verifyHmac } from '@opal/plugin-sdk';

export default definePlugin({
	start: async (ctx) => ctx.log('started', ctx.id),
	events: {
		record_changed: async (event, ctx) => ctx.log(event.data)
	},
	reconcile: { everyMinutes: 10, run: async (ctx) => {} },
	routes(app, ctx) {
		app.get('/panel/issue', (c) =>
			c.html(panelPage({ title: 'Tasks', theme: c.req.query('theme'), body: html`<p>${c.req.query('number')}</p>` }))
		);
		app.post('/hooks/task', async (c) => {
			const ok = verifyHmac(String(ctx.settings.secret), await c.req.text(), c.req.header('x-signature'));
			return ok ? c.json({ ok: true }) : c.json({ error: 'bad_signature' }, 401);
		});
	}
});
```

`definePlugin` starts the plugin at once. Do not call another start function.

## Context

| Field | Meaning |
|---|---|
| `id` | The plugin id. |
| `api` | The typed OPAL client. It is the same client as in the frontend. |
| `settings` | The setting values. Secrets are included. |
| `dataDir` | A folder the plugin owns. |
| `log(...)` | Writes one line to stdout. |
| `opalUrl` | The base URL of OPAL. |

An API call that fails throws `OpalApiError` with `status`, `code` and `message`.

## Environment

OPAL sets these variables. The plugin fails at start when one is missing.

- `OPAL_URL`: base URL of OPAL, without a trailing slash.
- `OPAL_TOKEN`: API token of the plugin user. It is limited to the permissions in the manifest.
- `OPAL_PLUGIN_ID`: the manifest id.
- `OPAL_PLUGIN_PORT`: the port to listen on. The host is `127.0.0.1`.
- `OPAL_PLUGIN_DATA`: the data folder.
- `OPAL_SETTINGS`: JSON with all setting values.

## HTTP

The SDK serves `GET /__health` and then your routes. OPAL reaches them at `/plugins/<id>/<path>`.
Webhooks use `/hooks/<id>/<path>` and reach your `/hooks/<path>` route. They carry no login.
Always check the signature of a webhook with `verifyHmac`.

`userOf(c)` returns the signed-in person from the `X-Opal-User` header, or `null`.

## Events and reconcile

The SDK reads the event stream and calls `events[type]`. An error in a handler is logged. It never stops the plugin.
The SDK reconnects after a failure. After each connection, and every `everyMinutes`, it runs `reconcile`.
Two reconcile runs never overlap. Use reconcile to repair what you missed while the stream was down.

## Panels

`panelPage({ title, body, theme })` returns a full HTML page with the OPAL colours.
Build `body` with `html`. It escapes every value you insert. Use `raw(text)` only for HTML you trust.

In a panel page, `window.opal.params` holds the query parameters and `window.opal.fetch(path, init)`
calls your plugin with the panel token. The page sends its height to OPAL by itself.

## Build

```bash
bun build src/plugin.ts --target=bun --outfile dist/plugin.js
```

The bundle holds hono, zod and the SDK. Nothing else is needed at run time.

## Test

Pass `{ env, signals: false }` as the second argument of `definePlugin` to run it in a test.
The returned handle has `port`, `ready` and `stop()`.
