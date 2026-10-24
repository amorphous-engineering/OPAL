/** Stand-in for `opal serve`: bun fake-child.ts <port> [--crash-after ms] [--bad-if-file path]. */
import { readFileSync } from 'node:fs';

const [portArg, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};
const badFile = opt('--bad-if-file');
if (badFile && readFileSync(badFile, 'utf8').includes('BAD')) {
	console.error('bad binary');
	process.exit(3);
}
Bun.serve({ port: Number(portArg), hostname: '127.0.0.1', fetch: () => Response.json({ ok: true }) });
console.log(`fake child listening on ${portArg}`);
console.error('fake child stderr line');
const crash = opt('--crash-after');
if (crash) setTimeout(() => process.exit(7), Number(crash));
process.on('SIGTERM', () => process.exit(0));
