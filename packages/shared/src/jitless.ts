import { z } from 'zod';

/**
 * Zod compiles its object parsers with `new Function` when the page allows it, and tests that
 * by trying. The web client's page policy has no 'unsafe-eval', so the try would be refused and
 * reported on every load. In a browser, switch the compiler off before any schema is built.
 * The server keeps it.
 */
if (typeof document !== 'undefined') z.config({ jitless: true });
