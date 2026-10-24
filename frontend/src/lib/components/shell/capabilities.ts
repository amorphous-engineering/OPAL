import type { About } from '@opal/shared';

/**
 * Whether the server implements an operation. The shell calls another area's
 * endpoint only when this is true, so a missing area never logs a failed request.
 */
export function hasOperation(
	about: About | null | undefined,
	method: string,
	path: string
): boolean {
	return about?.operations.some((o) => o.method === method && o.path === path) ?? false;
}
