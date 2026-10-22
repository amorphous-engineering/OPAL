/**
 * List-page URL state: every filter, sort and page lives in the query string, so
 * a list is shareable and back-button safe. One helper set drives every list.
 *
 * Conventions: `q` search, `sort` + `dir` ordering, `page` 1-based, other keys are
 * the filter's own name. Empty values drop out of the URL.
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryPatch = Record<string, QueryValue>;
export type SortState = { key: string; dir: 'asc' | 'desc' };

function apply(url: URL, patch: QueryPatch): URL {
	for (const [k, v] of Object.entries(patch)) {
		if (v === null || v === undefined || v === '' || v === false) url.searchParams.delete(k);
		else url.searchParams.set(k, v === true ? '1' : String(v));
	}
	// Any change other than paging returns to the first page.
	if (!('page' in patch)) url.searchParams.delete('page');
	else if (patch.page === 1 || patch.page === '1') url.searchParams.delete('page');
	return url;
}

/** The current URL with `patch` merged into its query string, as a relative href. */
export function queryHref(patch: QueryPatch): string {
	const url = apply(new URL(page.url.href), patch);
	return `${url.pathname}${url.search}`;
}

/** Navigate to the current page with `patch` merged. Focus and scroll are kept unless paging. */
export function setQuery(patch: QueryPatch, opts: { replace?: boolean } = {}) {
	return goto(queryHref(patch), { replace: opts.replace ?? false, reset: 'page' in patch });
}

/** A query parameter's current value ('' when absent). */
export function param(key: string, fallback = ''): string {
	return page.url.searchParams.get(key) ?? fallback;
}

/** True when any of the given keys carries a value. */
export function hasParams(keys: readonly string[]): boolean {
	return keys.some((k) => !!page.url.searchParams.get(k));
}

/** 1-based page number from the URL. */
export function pageNumber(): number {
	return Math.max(1, Number(page.url.searchParams.get('page')) || 1);
}

/**
 * Sort held in the URL (`sort`, `dir`). Use with DataTable:
 *   const s = urlSort({ key: 'name', dir: 'asc' });
 *   <DataTable bind:sort={() => s.value, s.set} serverSort ... />
 * The default order keeps the URL clean (no params).
 */
export function urlSort(def: SortState | null) {
	return {
		get value(): SortState | null {
			const key = page.url.searchParams.get('sort');
			if (!key) return def;
			const dir = page.url.searchParams.get('dir');
			return { key, dir: dir === 'asc' || dir === 'desc' ? dir : (def?.dir ?? 'asc') };
		},
		set(next: SortState | null) {
			const n = next ?? def;
			const isDefault = !n || (n.key === def?.key && n.dir === def?.dir);
			setQuery(isDefault ? { sort: null, dir: null } : { sort: n.key, dir: n.dir }, {
				replace: true
			});
		}
	};
}
