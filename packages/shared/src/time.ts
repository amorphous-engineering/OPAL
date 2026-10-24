/** Timestamps: ISO 8601 UTC text with millisecond precision and a Z suffix. */
import { z } from 'zod';

export const zTimestamp = z.iso.datetime({ offset: false });

export function now(): string {
	return new Date().toISOString();
}
