/**
 * The one rule for requests the server makes to a URL someone handed it: an OIDC issuer, the
 * endpoints its discovery document names, a `picture` claim.
 *
 * - The URL is parsed, never pattern-matched. A URL with a username or password is refused.
 * - http is for loopback hosts only.
 * - The address must be public, unless the host is the one the policy trusts. An admin may have
 *   put the identity provider on a private address on purpose, so that one host may be private.
 *   Whatever it then names (endpoints, pictures, redirects) gets no such trust.
 * - Link-local and cloud metadata addresses are refused whoever asks.
 * - Every redirect hop passes the same check.
 *
 * The check resolves the name, then fetch resolves it again, so a DNS server that answers
 * differently between the two can still slip through. Closing that means pinning the address,
 * which fetch does not offer for https. An egress firewall is the real boundary on a server that
 * must not reach its own network.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { envFlag } from '../../env.ts';

/** The URL breaks the rule. The message is for the server log and may name an address. */
export class OutboundRefused extends Error {}

export interface OutboundPolicy {
	/** `host[:port]` that may resolve to a private address. */
	trustedHost?: string | null;
}

const MAX_REDIRECTS = 3;

const blockList = (subnets: string[]) => {
	const list = new BlockList();
	for (const s of subnets) {
		const [address, prefix] = s.split('/') as [string, string];
		list.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
	}
	return list;
};

/** Unspecified, link-local, multicast and cloud metadata: no identity provider lives here. */
const NEVER = blockList([
	'0.0.0.0/8',
	'100.100.100.200/32',
	'168.63.129.16/32',
	'169.254.0.0/16',
	'224.0.0.0/4',
	'240.0.0.0/4',
	'::/128',
	'fd00:ec2::254/128',
	'fe80::/10',
	'ff00::/8'
]);

/** Everything else that is not the public internet. Tunnels that embed an IPv4 address count. */
const PRIVATE = blockList([
	'10.0.0.0/8',
	'100.64.0.0/10',
	'127.0.0.0/8',
	'172.16.0.0/12',
	'192.0.0.0/24',
	'192.0.2.0/24',
	'192.168.0.0/16',
	'198.18.0.0/15',
	'198.51.100.0/24',
	'203.0.113.0/24',
	'::/96',
	'64:ff9b::/96',
	'2001::/32',
	'2001:db8::/32',
	'2002::/16',
	'fc00::/7'
]);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const inList = (list: BlockList, address: string) => list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
const unbracketed = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

export const isLoopbackUrl = (url: URL) => LOOPBACK_HOSTNAMES.has(url.hostname);

/** An http(s) URL without credentials. */
export function parseOutboundUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OutboundRefused(`${raw} is not a URL`);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundRefused(`${url.protocol} is not http or https`);
	if (url.username || url.password) throw new OutboundRefused('The URL carries a username or password');
	return url;
}

/** Checks the URL against the rule and returns it, parsed. */
export async function checkOutbound(raw: string, policy: OutboundPolicy = {}): Promise<URL> {
	const url = parseOutboundUrl(raw);
	if (url.protocol === 'http:' && !isLoopbackUrl(url)) throw new OutboundRefused(`http is for loopback hosts only: ${url.host}`);
	const trusted = !!policy.trustedHost && url.host === policy.trustedHost;
	const hostname = unbracketed(url.hostname);
	let addresses: string[];
	if (isIP(hostname)) {
		addresses = [hostname];
	} else {
		try {
			addresses = (await lookup(hostname, { all: true })).map((a) => a.address);
		} catch (e) {
			// A trusted host may resolve only through an HTTP proxy: let the request itself fail.
			if (trusted) return url;
			throw new OutboundRefused(`${hostname} did not resolve: ${(e as Error).message}`);
		}
	}
	for (const address of addresses) {
		if (inList(NEVER, address)) throw new OutboundRefused(`${url.host} is on a refused address: ${address}`);
		if (!trusted && inList(PRIVATE, address)) throw new OutboundRefused(`${url.host} is on a private address: ${address}`);
	}
	return url;
}

/** A GET that checks the URL and every redirect it follows. */
export async function fetchChecked(raw: string, init: RequestInit, policy: OutboundPolicy = {}): Promise<Response> {
	let next = raw;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const url = await checkOutbound(next, policy);
		const res = await fetch(url, { ...init, redirect: 'manual' });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
		if (!location) return res;
		await res.body?.cancel();
		next = new URL(location, url).href;
	}
	throw new OutboundRefused(`More than ${MAX_REDIRECTS} redirects from ${raw}`);
}

/**
 * For libraries that make their own requests and treat a redirect as an error (openid-client, jose):
 * the same check, no following.
 */
export function checkedFetcher(policy: OutboundPolicy) {
	return async (url: string, init?: RequestInit): Promise<Response> =>
		fetch(await checkOutbound(url, policy), { ...init, redirect: 'manual' });
}

// ---------------------------------------------------------------- the OIDC issuer

/** `OPAL_OIDC_ALLOW_PRIVATE=0`: the identity provider must be on a public address as well. */
const privateIssuerAllowed = () => envFlag('OPAL_OIDC_ALLOW_PRIVATE', true);

/** Why this issuer URL cannot be used, or null. No network: this runs inside a settings write. */
export function issuerProblem(issuer: string): string | null {
	const shape = 'The issuer URL must be https:// (or a localhost URL for development), without a username or password.';
	let url: URL;
	try {
		url = parseOutboundUrl(issuer);
	} catch {
		return shape;
	}
	if (url.protocol === 'http:' && !isLoopbackUrl(url)) return shape;
	// The discovery path is appended to the issuer, so neither may cut it off.
	if (url.search || url.hash || /[?#]/.test(issuer)) return 'The issuer URL cannot have a query or a fragment.';
	const hostname = unbracketed(url.hostname);
	if (isIP(hostname) && inList(NEVER, hostname)) return 'The issuer URL cannot use a link-local or cloud metadata address.';
	if (!privateIssuerAllowed() && (isLoopbackUrl(url) || (isIP(hostname) && inList(PRIVATE, hostname)))) {
		return 'This server requires a public address for the issuer. The operator set OPAL_OIDC_ALLOW_PRIVATE.';
	}
	return null;
}

/** The policy for everything that follows from the configured issuer. */
export function issuerPolicy(issuer: string): OutboundPolicy {
	if (!issuer || !privateIssuerAllowed()) return {};
	try {
		return { trustedHost: parseOutboundUrl(issuer).host };
	} catch {
		return {};
	}
}
