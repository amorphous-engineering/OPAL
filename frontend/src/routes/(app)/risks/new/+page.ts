import { opal, orHttpError } from '#lib/api.js';
import { formProjectId } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = opal.using(fetch);
	const owners = await orHttpError(client.org.users.directory({}));
	// Context pre-fill: /risks/new?asset_part_id=12 (from a part page) names the asset already.
	let asset: { id: number; label: string } | null = null;
	const partId = Number(url.searchParams.get('asset_part_id'));
	if (partId) {
		try {
			const p = await client.parts.get({ id: partId });
			asset = { id: p.id, label: p.internalPn ? `${p.internalPn} ${p.name}` : p.name };
		} catch {
			/* unknown part: start with no asset */
		}
	}
	return { owners, asset, projectId: formProjectId(url) }; // added by projects
};
