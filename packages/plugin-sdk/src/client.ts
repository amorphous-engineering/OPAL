import { contracts, createClient, type Client, type Contracts, type Transport } from '@opal/shared';

export class OpalApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(`${status} ${code}: ${message}`);
		this.name = 'OpalApiError';
	}
}

export function makeTransport(opalUrl: string, token: string, fetchFn: typeof fetch = fetch): Transport {
	return async (req) => {
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
		if (req.body !== undefined) headers['Content-Type'] = 'application/json';
		const res = await fetchFn(`${opalUrl}/api${req.url}`, {
			method: req.method,
			headers,
			body: req.body === undefined ? undefined : JSON.stringify(req.body)
		});
		const text = await res.text();
		let body: unknown = undefined;
		if (text) {
			try {
				body = JSON.parse(text);
			} catch {
				body = undefined;
			}
		}
		if (!res.ok) {
			const b = (body ?? {}) as { error?: string; message?: string };
			throw new OpalApiError(res.status, b.error ?? 'unknown', b.message ?? (text.slice(0, 200) || res.statusText));
		}
		return body;
	};
}

export function makeApi(opalUrl: string, token: string, fetchFn?: typeof fetch): Client<Contracts> {
	return createClient(contracts, makeTransport(opalUrl, token, fetchFn));
}
