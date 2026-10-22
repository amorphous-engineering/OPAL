import { api, ApiError } from '#lib/api.js';
import type {
	InventoryItem,
	LocationSummary,
	StockByPart
} from '#lib/components/inventory/types.js';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

const FLAGS = ['low', 'attention', 'expired', 'expiring', 'calibration'] as const;
type Flag = (typeof FLAGS)[number];

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const view: 'records' | 'parts' = p.get('view') === 'parts' ? 'parts' : 'records';
	const q = p.get('q')?.trim() ?? '';
	const location = p.get('location') ?? '';
	const partId = p.get('part_id') ?? '';
	const source = p.get('source') ?? '';
	const flag = (FLAGS as readonly string[]).includes(p.get('flag') ?? '')
		? (p.get('flag') as Flag)
		: '';
	const depleted = p.get('depleted') === '1';
	const sort = p.get('sort') ?? (view === 'parts' ? 'part' : 'created_at');
	const order = p.get('dir') === 'asc' ? 'asc' : p.get('dir') === 'desc' ? 'desc' : null;
	const page = Math.max(1, Number(p.get('page')) || 1);

	const client = api.using(fetch);
	const paging = { skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE };
	const base = {
		search: q,
		location,
		part_id: partId || undefined,
		low_stock: flag === 'low' ? true : undefined,
		sort,
		order: order ?? (view === 'parts' || sort !== 'created_at' ? 'asc' : 'desc'),
		...paging
	};

	try {
		const [locations, result] = await Promise.all([
			client.get<LocationSummary[]>('/inventory/locations'),
			view === 'parts'
				? client.get<{ items: StockByPart[]; total: number }>('/inventory/by-part', base)
				: client.get<{ items: InventoryItem[]; total: number }>('/inventory', {
						...base,
						source_type: source,
						has_stock: depleted ? undefined : true,
						attention: flag === 'attention' ? true : undefined,
						expired: flag === 'expired' ? true : undefined,
						expiring_soon: flag === 'expiring' ? true : undefined,
						calibration_overdue: flag === 'calibration' ? true : undefined
					})
		]);
		return {
			view,
			records: view === 'records' ? (result.items as InventoryItem[]) : [],
			parts: view === 'parts' ? (result.items as StockByPart[]) : [],
			total: result.total,
			locations,
			q,
			location,
			partId,
			source,
			flag,
			depleted,
			sort,
			order: base.order as 'asc' | 'desc',
			page,
			pageSize: PAGE_SIZE,
			error: null as string | null
		};
	} catch (e) {
		return {
			view,
			records: [] as InventoryItem[],
			parts: [] as StockByPart[],
			total: 0,
			locations: [] as LocationSummary[],
			q,
			location,
			partId,
			source,
			flag,
			depleted,
			sort,
			order: 'asc' as 'asc' | 'desc',
			page,
			pageSize: PAGE_SIZE,
			error: e instanceof ApiError || e instanceof Error ? e.message : 'Could not load stock'
		};
	}
};
