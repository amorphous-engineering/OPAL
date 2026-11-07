/** `opal` entry point. With no command it starts the supervisor. */
// The passkey library's X.509 code (tsyringe) needs this polyfill before it loads.
// The compiled binary loads modules in bundle order, so it must come first.
import 'reflect-metadata';
import { importLegacy } from './commands/import.ts';
import { parseCommand, USAGE } from './commands/parse.ts';
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

const parsed = parseCommand(process.argv.slice(2));
if (parsed.kind === 'help') {
	console.log(USAGE);
	process.exit(0);
}
if (parsed.kind === 'error') {
	console.error(`${parsed.message}\n\n${USAGE}`);
	process.exit(2);
}
await commands[parsed.command]!(parsed.args);
