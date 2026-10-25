/** `opal` entry point. With no command it starts the supervisor. */
// The passkey library's X.509 code (tsyringe) needs this polyfill before it loads.
// The compiled binary loads modules in bundle order, so it must come first.
import 'reflect-metadata';
import { importLegacy } from './commands/import.ts';
import { serve } from './commands/serve.ts';
import { supervise } from './commands/supervise.ts';
import { update } from './commands/update.ts';
import { VERSION } from './version.ts';

const commands: Record<string, (args: string[]) => void | Promise<void>> = {
	supervise,
	serve,
	import: importLegacy,
	update,
	version: () => console.log(VERSION)
};

const argv = process.argv.slice(2);
// Without this, the rule below reads `--version` as a supervisor flag and starts a server.
if (argv[0] === '--version' || argv[0] === '-v') argv[0] = 'version';
// `opal --port 9000` means the supervisor with flags, not a command named "--port".
const [command, ...rest] = argv[0] && !argv[0].startsWith('--') ? argv : ['supervise', ...argv];
const run = commands[command!];
if (!run) {
	console.error(`Unknown command: ${command}. Commands: ${Object.keys(commands).join(', ')}`);
	process.exit(2);
}
await run(rest);
