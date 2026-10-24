/** Search function for EntityPicker: issues. */
import { opal } from '#lib/api.js';
import type { PickerOption } from '#lib/components/opal/index.js';

export async function searchIssues(q: string): Promise<PickerOption[]> {
	const r = await opal.issues.list({ q, limit: 20, dir: 'desc' });
	return r.items.map((i) => ({ value: i.id, label: i.issueNumber, sub: i.title }));
}
