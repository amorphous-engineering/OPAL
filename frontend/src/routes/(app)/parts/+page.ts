import { opal, orHttpError } from '#lib/api.js';
import { PART_SORT_KEYS, PART_STATES, PROCUREMENT } from '@opal/shared';
import type { PageLoad } from './$types';

const PARTS_PAGE_SIZE = 50;

const oneOf = <T extends string>(all: readonly T[], v: string | null): T | undefined =>
	all.find((x) => x === v);

export const load: PageLoad = async ({ url, fetch }) => {
	const p = url.searchParams;
	const client = opal.using(fetch);
	const state = oneOf(PART_STATES, p.get('state'));
	const procurement = oneOf(PROCUREMENT, p.get('procurement'));
	const sort = oneOf(PART_SORT_KEYS, p.get('sort')) ?? 'id';
	const dir = p.get('dir') === 'asc' ? 'asc' : 'desc';
	const q = p.get('q') ?? '';
	const tier = Number(p.get('tier')) || undefined;
	const category = p.get('category') ?? '';
	const tooling = p.get('tooling') === 'true' ? true : p.get('tooling') === 'false' ? false : undefined;
	const structure = p.get('structure') === 'top' || p.get('structure') === 'components' ? p.get('structure') : '';
	// The cursor is only valid for the filters it was issued under. A filter change drops
	// `page` from the URL (list helpers do that), which voids a cursor left behind.
	const page = Math.max(1, Number(p.get('page') ?? 1) || 1);
	const cursor = page > 1 ? (p.get('cursor') ?? undefined) : undefined;
	const [list, schema] = await orHttpError(
		Promise.all([
			client.parts.list({
				q: q || undefined,
				state,
				procurement,
				tier,
				category: category || undefined,
				tooling,
				topLevel: structure === 'top' ? true : structure === 'components' ? false : undefined,
				sort,
				dir,
				cursor,
				limit: PARTS_PAGE_SIZE
			}),
			client.parts.schema({})
		])
	);
	return {
		query: { q, state: state ?? '', page: cursor ? page : 1 },
		list,
		schema
	};
};
