import { opal } from '#lib/api.js';

type Client = ReturnType<typeof opal.using>;

/** Every project, for list filters. */
export async function projectOptions(client: Client) {
	return (await client.org.projects.list({ limit: 500 })).items;
}

/** The `project` filter of a list page, from the query string. */
export const filterProjectId = (url: URL): number | undefined =>
	Number(url.searchParams.get('project')) || undefined;

/** The project a create form is opened for: `?projectId=` from a project page. */
export const formProjectId = (url: URL): number => Number(url.searchParams.get('projectId')) || 0;
