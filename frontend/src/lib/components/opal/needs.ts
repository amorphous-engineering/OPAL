/** The required fields still blank, by name: `needs({ name: name.trim(), project: projectId })`. */
export function needs(fields: Record<string, unknown>): string[] {
	return Object.entries(fields)
		.filter(([, v]) => !v)
		.map(([k]) => k);
}
