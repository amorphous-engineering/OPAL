/**
 * JSON API client. Same-origin: the session cookie rides every request and
 * the server's Origin check covers CSRF. One error shape for the whole app.
 */
import { goto } from '$app/navigation';
import { navigating, page } from '$app/state';

export class ApiError extends Error {
	status: number;
	detail: unknown;

	constructor(status: number, detail: unknown) {
		super(formatDetail(detail, status));
		this.status = status;
		this.detail = detail;
	}
}

/** FastAPI error detail → one readable line. */
export function formatDetail(detail: unknown, status?: number): string {
	// A proxy answering for a dead API says only "Bad Gateway".
	if (status === 502 || status === 503 || status === 504) return 'Cannot reach the OPAL server';
	if (typeof detail === 'string') return detail;
	if (Array.isArray(detail)) {
		// 422 validation: [{loc: [...], msg}]
		return detail
			.map((d) => {
				const loc = Array.isArray(d?.loc)
					? d.loc.filter((p: unknown) => p !== 'body').join('.')
					: '';
				return loc ? `${loc}: ${d?.msg}` : String(d?.msg ?? d);
			})
			.join('; ');
	}
	if (detail && typeof detail === 'object') {
		const d = detail as Record<string, unknown>;
		// 409 draft_parts_blocked and similar structured refusals
		if (typeof d.message === 'string') return d.message;
		if (typeof d.remedy === 'string') return `${d.error ?? 'Refused'}: ${d.remedy}`;
		if (typeof d.detail === 'string') return d.detail;
	}
	return status ? `Request failed (${status})` : 'Request failed';
}

type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

function withQuery(path: string, query?: Query): string {
	if (!query) return path;
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) {
		if (v === undefined || v === null || v === '') continue;
		if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
		else params.set(k, String(v));
	}
	const qs = params.toString();
	return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

type Fetch = typeof fetch;

async function request<T>(
	fetchFn: Fetch,
	method: string,
	path: string,
	body?: unknown,
	query?: Query
): Promise<T> {
	const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
	if (body instanceof FormData) {
		init.body = body;
	} else if (body !== undefined) {
		(init.headers as Record<string, string>)['Content-Type'] = 'application/json';
		init.body = JSON.stringify(body);
	}
	let res: Response;
	try {
		res = await fetchFn(withQuery(`/api${path}`, query), init);
	} catch {
		throw new ApiError(503, 'Cannot reach the OPAL server');
	}
	if (res.status === 401 && !path.startsWith('/auth/')) {
		// Session ended: send the browser to sign in, then back here.
		// A page load that 401s runs mid-navigation: the destination is the page to come back to.
		// On the very first load neither exists yet, so fall back to the address bar.
		const at = navigating.to?.url ?? page.url;
		const here = at.pathname ? at.pathname + at.search : location.pathname + location.search;
		if (!here.startsWith('/login') && !here.startsWith('/setup') && !here.startsWith('/claim'))
			goto(`/login?next=${encodeURIComponent(here)}`);
	}
	if (!res.ok) {
		let detail: unknown = res.statusText;
		try {
			const data = await res.json();
			detail = data?.detail ?? data;
		} catch {
			/* non-JSON error body */
		}
		throw new ApiError(res.status, detail);
	}
	if (res.status === 204) return undefined as T;
	const type = res.headers.get('content-type') ?? '';
	return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

function client(fetchFn: Fetch = (...a) => fetch(...a)) {
	return {
		get: <T>(path: string, query?: Query) => request<T>(fetchFn, 'GET', path, undefined, query),
		post: <T>(path: string, body?: unknown, query?: Query) =>
			request<T>(fetchFn, 'POST', path, body, query),
		put: <T>(path: string, body?: unknown) => request<T>(fetchFn, 'PUT', path, body),
		patch: <T>(path: string, body?: unknown) => request<T>(fetchFn, 'PATCH', path, body),
		del: <T = void>(path: string, query?: Query) =>
			request<T>(fetchFn, 'DELETE', path, undefined, query),
		/** Bind to the `fetch` a SvelteKit `load` receives: `api.using(fetch).get(...)`. */
		using: (f: Fetch) => client(f)
	};
}

/** The API client. In `load` functions use `api.using(fetch)`. */
export const api = client();

/** Paginated list envelope used by most list endpoints. */
export interface Page<T> {
	items: T[];
	total: number;
	page?: number;
	page_size?: number;
}
