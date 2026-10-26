// Test plugin: no SDK, only Bun.serve.
const call = async (path) => {
	const res = await fetch(`${process.env.OPAL_URL}/api${path}`, {
		headers: { authorization: `Bearer ${process.env.OPAL_TOKEN}` }
	});
	return { status: res.status, body: await res.json().catch(() => null) };
};

Bun.serve({
	port: Number(process.env.OPAL_PLUGIN_PORT),
	hostname: '127.0.0.1',
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === '/__health') return new Response('ok');
		if (url.pathname === '/env') {
			return Response.json(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OPAL_') || k === 'BUN_BE_BUN')));
		}
		if (url.pathname === '/call') return Response.json(await call(url.searchParams.get('path')));
		if (url.pathname === '/crash') {
			setTimeout(() => process.exit(3), 10);
			return Response.json({ ok: true });
		}
		if (url.pathname === '/say') {
			console.log('hello from echo');
			console.error('trouble from echo');
			return Response.json({ ok: true });
		}
		return new Response('not found', { status: 404 });
	}
});
