/** `opal` entry point. With no command it starts the supervisor. */
// The passkey library's X.509 code (tsyringe) needs this polyfill before it loads.
// The compiled binary loads modules in bundle order, so it must come first.
import 'reflect-metadata';
import { importLegacy } from './commands/import.ts';
import { serve } from './commands/serve.ts';
import { supervise } from './commands/supervise.ts';
import { update } from './commands/update.ts';

const commands: Record<string, (args: string[]) => void | Promise<void>> = {
	supervise,
	serve,
	import: importLegacy,
	update
};

const argv = process.argv.slice(2);
// `opal --port 9000` means the supervisor with flags, not a command named "--port".
const [command, ...rest] = argv[0] && !argv[0].startsWith('--') ? argv : ['supervise', ...argv];
const run = commands[command!];
if (!run) {
	console.error(`Unknown command: ${command}. Commands: ${Object.keys(commands).join(', ')}`);
	process.exit(2);
}
await run(rest);
