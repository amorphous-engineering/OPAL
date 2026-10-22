import { api } from '#lib/api.js';
import type { ExtensionList } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({
	extensions: await api.using(fetch).get<ExtensionList>('/extensions')
});
