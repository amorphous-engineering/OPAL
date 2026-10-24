/**
 * Lists the operations no test calls.
 *   OPAL_OP_COVERAGE=/tmp/ops.txt bun test && bun scripts/op-coverage.ts /tmp/ops.txt
 */
import { readFileSync } from 'node:fs';
import { impls } from '../src/ops/index.ts';

const called = new Set(readFileSync(process.argv[2]!, 'utf8').split('\n').filter(Boolean));
const all = impls.map((i) => i.contract.name);
const missing = all.filter((n) => !called.has(n));
console.log(`${all.length - missing.length} of ${all.length} operations called by tests`);
for (const n of missing) console.log(`  not called: ${n}`);
process.exit(missing.length ? 1 : 0);
