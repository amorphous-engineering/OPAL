import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	const role = url.searchParams.get('role');
	redirect(307, `/settings${role ? `?role=${encodeURIComponent(role)}` : ''}#roles`);
};
