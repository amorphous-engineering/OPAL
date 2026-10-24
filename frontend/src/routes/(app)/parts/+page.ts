import { opal } from '#lib/api.js';
import { PART_STATES, type PartState } from '@opal/shared';
import type { PageLoad } from './$types';

const PARTS_PAGE_SIZE = 50;

export const load: PageLoad = async ({ url, fetch }) => {
	const p = url.searchParams;
	const state = PART_STATES.find((s) => s === p.get('state')) as PartState | undefined;
	const q = p.get('q') ?? '';
	// The cursor is only valid for the filters it was issued under. A filter change drops
	// `page` from the URL (list helpers do that), which voids a cursor left behind.
	const page = Math.max(1, Number(p.get('page') ?? 1) || 1);
	const cursor = page > 1 ? (p.get('cursor') ?? undefined) : undefined;
	const list = await opal.using(fetch).parts.list({
		q: q || undefined,
		state,
		cursor,
		limit: PARTS_PAGE_SIZE
	});
	return { query: { q, state: state ?? '', page: cursor ? page : 1 }, list };
};
