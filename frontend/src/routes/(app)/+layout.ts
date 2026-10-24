import { api, opal } from '#lib/api.js';
import { hasOperation } from '#lib/components/shell/capabilities.js';
import { requireSession } from '#lib/session-guard.js';
import type { LayoutLoad } from './$types';

// Every page in (app) requires a signed-in user.
export const load: LayoutLoad = async ({ url, fetch }) => {
	const user = await requireSession(url, fetch, { profileSetup: true });
	const client = opal.using(fetch).platform;
	// Shell facts: the version, which operations exist, and the bell's count. A failed lookup
	// leaves that part of the shell blank rather than breaking the page.
	const [about, unread] = await Promise.all([
		client.about({}).catch(() => null),
		client.notifications.unreadCount({}).catch(() => null)
	]);
	// Demo state shows as a banner on every page. Asked only when this server has the
	// endpoint (an area not built yet must not log a failed request).
	const lifecycle = hasOperation(about, 'GET', '/settings/lifecycle')
		? await api
				.using(fetch)
				.get<{ demo_active: boolean }>('/settings/lifecycle')
				.catch(() => null)
		: null;
	return {
		user,
		about,
		unreadCount: unread?.unreadCount ?? 0,
		demoActive: lifecycle?.demo_active ?? false
	};
};
