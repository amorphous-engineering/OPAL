import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const client = opal.using(fetch);
	const id = Number(params.id);
	const [risk, readiness, history, owners] = await orHttpError(
		Promise.all([
			client.risks.get({ id }),
			client.risks.readiness({ id }),
			client.risks.history({ id }),
			client.org.users.directory({})
		])
	);
	return { risk, readiness, history, owners };
};
