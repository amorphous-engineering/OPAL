import { afterEach } from 'bun:test';
import { assetName, sha256Hex } from '../src/supervisor/updater.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) void s.stop(true);
});

/** Local stand-in for the GitHub API and the asset downloads. */
export function mockGithub(opts: {
	tag: string;
	binary: string;
	platform?: string;
	arch?: string;
	sums?: 'good' | 'bad' | 'none' | 'missing-entry';
}) {
	const name = assetName(opts.platform ?? 'linux', opts.arch ?? 'x64');
	const hash = sha256Hex(new TextEncoder().encode(opts.binary));
	const server: ReturnType<typeof Bun.serve> = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req): Response {
			const base: string = `http://127.0.0.1:${server.port}`;
			const path = new URL(req.url).pathname;
			if (path === '/latest') {
				const assets: { name: string; browser_download_url: string }[] = [{ name, browser_download_url: `${base}/dl/${name}` }];
				if (opts.sums !== 'none') assets.push({ name: 'SHA256SUMS', browser_download_url: `${base}/dl/SHA256SUMS` });
				return Response.json({ tag_name: opts.tag, body: 'notes', assets });
			}
			if (path === `/dl/${name}`) return new Response(opts.binary);
			if (path === '/dl/SHA256SUMS') {
				const h = opts.sums === 'bad' ? 'a'.repeat(64) : hash;
				return new Response(`${h}  ${opts.sums === 'missing-entry' ? 'other' : name}\n`);
			}
			return new Response('nope', { status: 404 });
		}
	});
	servers.push(server);
	return { apiUrl: `http://127.0.0.1:${server.port}/latest`, name, hash };
}
