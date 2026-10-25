import { ApiError, opal } from '#lib/api.js';
import {
	STOCK_BY_PART_SORT_KEYS,
	STOCK_SORT_KEYS,
	type StockByPart,
	type StockLocation,
	type StockRecord
} from '@opal/shared';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

const FLAGS = ['low', 'attention', 'expired', 'expiring', 'calibration'] as const;
type Flag = (typeof FLAGS)[number];

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const q = p.get('q')?.trim() ?? '';
	const location = p.get('location') ?? '';
	const partId = Number(p.get('part_id')) || undefined;
	const source = p.get('source') ?? '';
	const flag = (FLAGS as readonly string[]).includes(p.get('flag') ?? '')
		? (p.get('flag') as Flag)
		: '';
	const depleted = p.get('depleted') === '1';
	// By part is the default. A link to one part, or a filter only records have, means records.
	const wantsRecords = !!partId || !!source || depleted || (flag !== '' && flag !== 'low');
	const view: 'records' | 'parts' =
		p.get('view') === 'records' || (p.get('view') !== 'parts' && wantsRecords)
			? 'records'
			: 'parts';
	const sortParam = p.get('sort') ?? '';
	const dir = p.get('dir');
	const page = Math.max(1, Number(p.get('page')) || 1);
	const cursor = page > 1 ? String((page - 1) * PAGE_SIZE) : undefined;

	const client = opal.using(fetch);
	const base = {
		q: q || undefined,
		location: location || undefined,
		partId,
		lowStock: flag === 'low' ? true : undefined,
		cursor,
		limit: PAGE_SIZE
	};
	const result = {
		view,
		q,
		location,
		partId: partId ?? null,
		source,
		flag,
		depleted,
		page,
		pageSize: PAGE_SIZE
	};

	try {
		const locations = await client.inventory.locations({});
		if (view === 'parts') {
			const sort = (STOCK_BY_PART_SORT_KEYS as readonly string[]).includes(sortParam)
				? (sortParam as (typeof STOCK_BY_PART_SORT_KEYS)[number])
				: 'part';
			const order = dir === 'desc' ? 'desc' : 'asc';
			const list = await client.inventory.byPart({ ...base, sort, order });
			return {
				...result,
				sort,
				order,
				records: [] as StockRecord[],
				parts: list.items,
				total: list.total,
				locations,
				error: null as string | null
			};
		}
		const sort = (STOCK_SORT_KEYS as readonly string[]).includes(sortParam)
			? (sortParam as (typeof STOCK_SORT_KEYS)[number])
			: 'createdAt';
		const order =
			dir === 'asc' ? 'asc' : dir === 'desc' ? 'desc' : sort === 'createdAt' ? 'desc' : 'asc';
		const list = await client.inventory.list({
			...base,
			sort,
			order,
			sourceType: (source || undefined) as 'purchase' | undefined,
			hasStock: depleted ? undefined : true,
			attention: flag === 'attention' ? true : undefined,
			expired: flag === 'expired' ? true : undefined,
			expiringSoon: flag === 'expiring' ? true : undefined,
			calibrationOverdue: flag === 'calibration' ? true : undefined
		});
		return {
			...result,
			sort,
			order,
			records: list.items,
			parts: [] as StockByPart[],
			total: list.total,
			locations,
			error: null as string | null
		};
	} catch (e) {
		return {
			...result,
			sort: sortParam,
			order: 'asc' as const,
			records: [] as StockRecord[],
			parts: [] as StockByPart[],
			total: 0,
			locations: [] as StockLocation[],
			error: e instanceof ApiError || e instanceof Error ? e.message : 'Could not load stock'
		};
	}
};
