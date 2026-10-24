/** Display helpers for stock. The data shapes come from `@opal/shared`. */
import type { StockLedgerRow, StockSource } from '@opal/shared';

export const SOURCE_LABEL: Record<StockSource, string> = {
	purchase: 'PURCHASE',
	production: 'PRODUCED',
	manual: 'MANUAL',
	transfer: 'MOVED'
};

export function sourceLabel(type: string | null | undefined): string {
	return type ? (SOURCE_LABEL[type as StockSource] ?? type.toUpperCase()) : '—';
}

type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted' | 'default';

/** State word and tone of a ledger row. */
export function ledgerKind(row: Pick<StockLedgerRow, 'kind' | 'qty' | 'reason'>): {
	label: string;
	tone: Tone;
} {
	const n = Number(row.qty);
	switch (row.kind) {
		case 'receive':
			return { label: 'RECEIVED', tone: 'ok' };
		case 'produce':
			return { label: 'PRODUCED', tone: 'ok' };
		case 'consume':
			if (row.reason === 'tooling') return { label: 'TOOLING', tone: 'info' };
			if (row.reason === 'scrap') return { label: 'SCRAPPED', tone: 'error' };
			return { label: 'CONSUMED', tone: 'warn' };
		case 'adjust':
			return row.reason === 'scrap' || row.reason === 'damage'
				? { label: 'SCRAPPED', tone: 'error' }
				: { label: 'ADJUSTED', tone: 'default' };
		case 'count':
			return { label: 'COUNTED', tone: 'info' };
		case 'transfer':
			return { label: n > 0 ? 'MOVED IN' : n < 0 ? 'MOVED OUT' : 'MOVED', tone: 'info' };
	}
}

/** Link columns that other areas add to a move, as something a person can read or follow. */
const LINKS: Record<string, { label: string; href?: (id: number) => string }> = {
	executionId: { label: 'EXECUTION', href: (id) => `/executions/${id}` },
	purchaseLineId: { label: 'PURCHASE' },
	purchaseId: { label: 'PURCHASE', href: (id) => `/purchases/${id}` }
};

export function moveLinks(links: Record<string, number>): { label: string; href: string | null }[] {
	return Object.entries(links).flatMap(([k, id]) => {
		if (k === 'purchaseLineId' && 'purchaseId' in links) return [];
		const l = LINKS[k];
		return l ? [{ label: l.label, href: l.href ? l.href(id) : null }] : [];
	});
}
