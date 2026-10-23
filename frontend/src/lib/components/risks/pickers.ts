/** Search function for EntityPicker: issues. */
import { api, type Page } from '#lib/api.js';
import type { PickerOption } from '#lib/components/opal/index.js';

interface IssueRow {
	id: number;
	issue_number: string | null;
	title: string;
	status: string;
}

export async function searchIssues(q: string): Promise<PickerOption[]> {
	const r = await api.get<Page<IssueRow>>('/issues', { search: q, page_size: 20 });
	return r.items.map((i) => ({
		value: i.id,
		label: i.issue_number ?? 'issue',
		sub: i.title
	}));
}
