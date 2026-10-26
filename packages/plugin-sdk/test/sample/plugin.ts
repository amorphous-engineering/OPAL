import { definePlugin, html, panelPage } from '../../src/index.ts';

export default definePlugin({
	events: { record_changed: (e, ctx) => ctx.log('changed', e.data) },
	routes(app) {
		app.get('/panel/issue', (c) => c.html(panelPage({ title: 'Sample', body: html`<p>${c.req.query('number')}</p>`, theme: c.req.query('theme') })));
	}
});
