/** Find a plugin on GitHub: parse the source, resolve a ref to a commit, download the tarball. */
import { OpalError } from '@opal/shared';

export interface ParsedSource {
	/** What the database stores: `github:owner/repo` or `local:/abs/path`. */
	source: string;
	/** Tag, branch or commit the admin asked for. Null: the default branch. */
	ref: string | null;
	kind: 'github' | 'local';
	owner?: string;
	repo?: string;
	path?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (url, init) => fetch(url, init);

/** Tests replace the network. Pass nothing to restore it. */
export function setGithubFetch(f?: Fetch): void {
	fetchImpl = f ?? ((url, init) => fetch(url, init));
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const bad = (msg: string) => new OpalError(422, 'invalid_source', msg, { source: msg });

export const localPluginsAllowed = () => process.env.OPAL_PLUGINS_LOCAL === '1';

function repoParts(owner: string, repo: string): { owner: string; repo: string } {
	const r = repo.replace(/\.git$/, '');
	if (!NAME.test(owner) || !NAME.test(r)) throw bad('Use owner/repo, owner/repo@ref or a github.com URL');
	return { owner, repo: r };
}

export function parseSource(input: string): ParsedSource {
	const text = input.trim();
	if (text.startsWith('local:')) {
		if (!localPluginsAllowed()) throw bad('Local plugins are off on this server');
		const path = text.slice('local:'.length);
		if (!path.startsWith('/')) throw bad('A local source needs an absolute path');
		return { source: `local:${path}`, ref: null, kind: 'local', path };
	}
	let owner: string;
	let repo: string;
	let ref: string | null = null;
	if (/^https?:\/\//i.test(text)) {
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			throw bad('The URL is not valid');
		}
		if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') throw bad('Only github.com is supported');
		const parts = url.pathname.split('/').filter(Boolean);
		if (parts.length < 2) throw bad('The URL needs an owner and a repository');
		[owner, repo] = [parts[0]!, parts[1]!];
		if (parts.length > 2) {
			if (parts[2] !== 'tree' || parts.length < 4) throw bad('Use github.com/owner/repo or .../tree/<ref>');
			ref = decodeURIComponent(parts.slice(3).join('/'));
		}
	} else {
		const at = text.indexOf('@');
		const head = at < 0 ? text : text.slice(0, at);
		ref = at < 0 ? null : text.slice(at + 1) || null;
		const parts = head.split('/');
		if (parts.length !== 2) throw bad('Use owner/repo, owner/repo@ref or a github.com URL');
		[owner, repo] = [parts[0]!, parts[1]!];
	}
	const r = repoParts(owner, repo);
	return { source: `github:${r.owner}/${r.repo}`, ref, kind: 'github', ...r };
}

/** `github:owner/repo` as stored. */
export function parseStored(source: string): ParsedSource {
	return parseSource(source.startsWith('github:') ? source.slice('github:'.length) : source);
}

async function get(url: string, headers: Record<string, string>, what: string): Promise<Response> {
	let res: Response;
	try {
		res = await fetchImpl(url, { headers: { 'user-agent': 'opal-plugin-installer', ...headers }, redirect: 'follow' });
	} catch (e) {
		throw new OpalError(502, 'github_unreachable', `Cannot reach GitHub: ${(e as Error).message}`);
	}
	if (res.ok) return res;
	if (res.status === 404) throw new OpalError(404, 'github_not_found', `${what} not found on GitHub. The repository must be public.`);
	if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
		throw new OpalError(429, 'github_rate_limited', 'GitHub rate limit reached. Try again later.');
	}
	throw new OpalError(502, 'github_error', `GitHub answered ${res.status} for ${what}`);
}

/** The 40-hex commit of a ref (or of the default branch). */
export async function resolveSha(owner: string, repo: string, ref: string | null): Promise<string> {
	const target = ref ? encodeURIComponent(ref) : 'HEAD';
	const res = await get(
		`https://api.github.com/repos/${owner}/${repo}/commits/${target}`,
		{ accept: 'application/vnd.github.sha' },
		ref ? `Ref ${ref} of ${owner}/${repo}` : `Repository ${owner}/${repo}`
	);
	const sha = (await res.text()).trim();
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new OpalError(502, 'github_error', 'GitHub did not return a commit SHA');
	return sha;
}

export async function downloadTarball(owner: string, repo: string, sha: string): Promise<Uint8Array> {
	const res = await get(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, {}, `Commit ${sha.slice(0, 7)} of ${owner}/${repo}`);
	try {
		return new Uint8Array(await res.arrayBuffer());
	} catch (e) {
		throw new OpalError(502, 'github_unreachable', `The download from GitHub failed: ${(e as Error).message}`);
	}
}
