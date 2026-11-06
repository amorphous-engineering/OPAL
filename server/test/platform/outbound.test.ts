import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { checkOutbound, fetchChecked, issuerPolicy, issuerProblem, OutboundRefused } from '../../src/services/platform/outbound.ts';

const refused = async (url: string, policy = {}) => {
	const err = await checkOutbound(url, policy).then(
		() => null,
		(e) => e
	);
	expect(err).toBeInstanceOf(OutboundRefused);
};

afterEach(() => {
	delete process.env.OPAL_OIDC_ALLOW_PRIVATE;
});

describe('what the server may fetch', () => {
	test('a URL with a username or password is refused, whatever host it seems to name', async () => {
		await refused('http://localhost:x@127.0.0.2:9000/');
		await refused('https://user:pass@example.com/', { trustedHost: 'example.com' });
		await refused('https://localhost@10.0.0.1/', { trustedHost: '10.0.0.1' });
	});

	test('a scheme other than http or https is refused', async () => {
		await refused('file:///etc/passwd');
		await refused('ftp://example.com/x');
		await refused('not a url');
	});

	test('http is for loopback hosts only, even a trusted one', async () => {
		await refused('http://example.com/x');
		await refused('http://10.0.0.1/x', { trustedHost: '10.0.0.1' });
	});

	const privateAddresses = [
		'10.1.2.3',
		'100.64.0.1',
		'127.0.0.2',
		'172.16.0.1',
		'192.168.1.1',
		'[::1]',
		'[fd00::1]', '[fec0::1]',
		'[::ffff:10.0.0.1]',
		'[::ffff:127.0.0.1]'
	];
	for (const host of privateAddresses) {
		test(`private address ${host} is refused without trust and allowed for the trusted host`, async () => {
			await refused(`https://${host}/x`);
			await expect(checkOutbound(`https://${host}/x`, { trustedHost: host === '[::ffff:10.0.0.1]' ? '[::ffff:a00:1]' : host === '[::ffff:127.0.0.1]' ? '[::ffff:7f00:1]' : host })).resolves.toBeInstanceOf(URL);
		});
	}

	for (const host of ['169.254.169.254', '168.63.129.16', '100.100.100.200', '0.0.0.0', '[fe80::1]', '[fd00:ec2::254]']) {
		test(`link-local or metadata address ${host} is refused even when trusted`, async () => {
			await refused(`https://${host}/x`, { trustedHost: host });
		});
	}

	test('other spellings of a private address are caught', async () => {
		await refused('https://2130706433/');
		await refused('https://0x7f.1/');
		await refused('https://127.1/');
	});

	test('a public address passes', async () => {
		await expect(checkOutbound('https://93.184.216.34/x')).resolves.toBeInstanceOf(URL);
		await expect(checkOutbound('https://[2606:2800:220:1::1]/x')).resolves.toBeInstanceOf(URL);
	});

	test('a name is judged by what it resolves to', async () => {
		await refused('https://localhost/x');
		await expect(checkOutbound('https://localhost/x', { trustedHost: 'localhost' })).resolves.toBeInstanceOf(URL);
	});

	test('trust is for one host and port, not for the machine', async () => {
		await refused('http://localhost:2/x', { trustedHost: 'localhost:1' });
	});

	test('a name that does not resolve is refused unless trusted', async () => {
		await refused('https://nothing.invalid/x');
		await expect(checkOutbound('https://nothing.invalid/x', { trustedHost: 'nothing.invalid' })).resolves.toBeInstanceOf(URL);
	});
});

describe('redirects', () => {
	let hits: string[];
	let a: ReturnType<typeof Bun.serve>;
	let b: ReturnType<typeof Bun.serve>;
	beforeAll(() => {
		const handler = (req: Request) => {
			const url = new URL(req.url);
			hits.push(`${url.host}${url.pathname}`);
			if (url.pathname === '/to-b') return new Response(null, { status: 302, headers: { location: `http://localhost:${b.port}/x` } });
			if (url.pathname === '/to-self') return new Response(null, { status: 301, headers: { location: '/end' } });
			if (url.pathname === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
			if (url.pathname === '/to-creds') return new Response(null, { status: 302, headers: { location: `http://u:p@${url.host}/end` } });
			return new Response('end');
		};
		a = Bun.serve({ port: 0, hostname: 'localhost', fetch: handler });
		b = Bun.serve({ port: 0, hostname: 'localhost', fetch: handler });
		hits = [];
	});
	afterAll(() => {
		a.stop(true);
		b.stop(true);
	});
	const trusted = () => ({ trustedHost: `localhost:${a.port}` });

	test('a redirect on the trusted host is followed', async () => {
		hits = [];
		const res = await fetchChecked(`http://localhost:${a.port}/to-self`, {}, trusted());
		expect(await res.text()).toBe('end');
		expect(hits).toHaveLength(2);
	});

	test('a redirect to a private host is refused before any request reaches it', async () => {
		hits = [];
		await expect(fetchChecked(`http://localhost:${a.port}/to-b`, {}, trusted())).rejects.toBeInstanceOf(OutboundRefused);
		expect(hits).toEqual([`localhost:${a.port}/to-b`]);
	});

	test('a redirect to a URL with credentials is refused', async () => {
		await expect(fetchChecked(`http://localhost:${a.port}/to-creds`, {}, trusted())).rejects.toBeInstanceOf(OutboundRefused);
	});

	test('a redirect loop ends at the hop limit', async () => {
		hits = [];
		await expect(fetchChecked(`http://localhost:${a.port}/loop`, {}, trusted())).rejects.toBeInstanceOf(OutboundRefused);
		expect(hits.length).toBe(4);
	});
});

describe('the issuer URL', () => {
	test('https on any host is usable, private addresses included', () => {
		for (const issuer of ['https://id.example.com', 'https://id.example.com/realms/opal', 'https://10.0.0.5', 'https://keycloak.corp.local:8443/auth']) {
			expect(issuerProblem(issuer)).toBeNull();
		}
	});

	test('http is usable on loopback only', () => {
		for (const issuer of ['http://localhost:9000', 'http://127.0.0.1:9000', 'http://[::1]:9000']) expect(issuerProblem(issuer)).toBeNull();
		for (const issuer of ['http://id.example.com', 'http://127.0.0.2:9000', 'http://10.0.0.5']) expect(issuerProblem(issuer)).toContain('https://');
	});

	test('credentials, a query or a fragment are refused', () => {
		expect(issuerProblem('http://localhost:x@127.0.0.2:9000')).toContain('username or password');
		expect(issuerProblem('https://user@id.example.com')).toContain('username or password');
		expect(issuerProblem('https://10.0.0.5/secret.json?')).toContain('query');
		expect(issuerProblem('https://10.0.0.5/secret.json#')).toContain('fragment');
	});

	test('a metadata address is refused', () => {
		expect(issuerProblem('https://169.254.169.254')).toContain('metadata');
	});

	test('the configured issuer host is trusted by default', () => {
		expect(issuerPolicy('https://10.0.0.5:8443/realm')).toEqual({ trustedHost: '10.0.0.5:8443' });
	});

	for (const value of ['0', 'false', 'off']) {
		test(`OPAL_OIDC_ALLOW_PRIVATE=${value} takes that trust away and refuses a private issuer`, async () => {
			process.env.OPAL_OIDC_ALLOW_PRIVATE = value;
			expect(issuerPolicy('https://10.0.0.5')).toEqual({});
			for (const issuer of ['https://10.0.0.5', 'http://localhost:9000', 'http://127.0.0.1:9000']) {
				expect(issuerProblem(issuer)).toContain('OPAL_OIDC_ALLOW_PRIVATE');
			}
			expect(issuerProblem('https://id.example.com')).toBeNull();
			await refused('https://localhost/.well-known/openid-configuration', issuerPolicy('https://localhost'));
		});
	}
});
