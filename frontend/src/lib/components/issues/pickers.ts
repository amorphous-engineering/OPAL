/** Search functions for EntityPicker: the records an issue links to, via /api/search. */
import { api } from '#lib/api.js';
import type { PickerOption } from '#lib/components/opal/index.js';

interface SearchResult {
	entity_type: string;
	id: number;
	label: string;
	sublabel: string | null;
}

export type LinkKind = 'procedure' | 'execution' | 'risk';

/** Search one kind of record. The number leads, the name follows (voice rule 7). */
export function searchKind(kind: LinkKind): (q: string) => Promise<PickerOption[]> {
	return async (q) => {
		if (!q) return [];
		const all = await api.get<SearchResult[]>('/search', { q, limit: 10 });
		return all
			.filter((r) => r.entity_type === kind)
			.map((r) =>
				// Procedures carry a database id as sublabel; never show it.
				kind === 'procedure' || !r.sublabel
					? { value: r.id, label: r.label }
					: { value: r.id, label: r.sublabel, sub: r.label }
			);
	};
}
