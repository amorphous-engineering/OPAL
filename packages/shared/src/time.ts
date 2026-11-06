/** Timestamps: ISO 8601 UTC text with millisecond precision and a Z suffix. */
import { z } from 'zod';
import { MAX_TIMESTAMP } from './limits.ts';

export const zTimestamp = z.iso.datetime({ offset: false }).max(MAX_TIMESTAMP);

export function now(): string {
	return new Date().toISOString();
}
