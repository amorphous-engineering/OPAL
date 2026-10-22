/** Search functions for EntityPicker: parts and issues. */
import { api, type Page } from '#lib/api.js';
import type { PickerOption } from './EntityPicker.svelte';

interface PartRow {
	id: number;
	internal_pn: string | null;
	name: string;
}

interface IssueRow {
	id: number;
	issue_number: string | null;
	title: string;
	status: string;
}

export async function searchParts(q: string): Promise<PickerOption[]> {
	const r = await api.get<Page<PartRow>>('/parts', { search: q, limit: 20 });
	return r.items.map((p) => ({ value: p.id, label: p.internal_pn ?? 'no PN', sub: p.name }));
}

export async function searchIssues(q: string): Promise<PickerOption[]> {
	const r = await api.get<Page<IssueRow>>('/issues', { search: q, page_size: 20 });
	return r.items.map((i) => ({
		value: i.id,
		label: i.issue_number ?? 'issue',
		sub: i.title
	}));
}
