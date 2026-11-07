/** What `opal <args>` asks for. Decided before any command runs, so a wrong flag starts nothing. */

/** Flags per command. `true`: the flag takes a value. */
const FLAGS: Record<string, Record<string, boolean>> = {
	supervise: { 'control-port': true, 'no-browser': false, port: true, host: true },
	serve: { port: true, host: true },
	import: { out: true, project: true, attachments: true, 'accept-failed-rows': false },
	backup: { keep: true },
	restore: {},
	secrets: {},
	update: {},
	version: {}
};

export const USAGE = `Usage: opal [command] [flags]

  opal                    Start OPAL and its control page
      --port <n>          Port for OPAL (default 8080)
      --host <addr>       Address to listen on (default 0.0.0.0)
      --control-port <n>  Port for the control page (default 8079)
      --no-browser        Do not open the control page
  opal serve              Start the server without the control page
      --port <n>, --host <addr>
  opal import <file>      Import a 1.x database
      --out <file>        Where to write the new database
      --project <file>    The opal.project.yaml, if OPAL cannot find it
      --attachments <dir> The 1.x attachments folder, if OPAL cannot find it
      --accept-failed-rows  Import although some rows fail. Without it nothing changes
  opal backup <folder>    Write a backup into a new subfolder, while OPAL runs or not
      --keep <n>          Then remove older finished backups beyond the newest n
  opal restore <backup>   Restore a backup into an empty data folder
  opal secrets rotate     Replace the key to stored secrets, with OPAL stopped
  opal update             Install the newest release
  opal version            Print the version
  opal help               Print this

Data lives in OPAL_DATA_DIR, or the default folder for this system.
`;

export type Parsed =
	| { kind: 'help' }
	| { kind: 'run'; command: string; args: string[] }
	| { kind: 'error'; message: string };

export function parseCommand(argv: string[]): Parsed {
	if (argv.some((a) => a === '--help' || a === '-h') || argv[0] === 'help') return { kind: 'help' };
	const args = [...argv];
	if (args[0] === '--version' || args[0] === '-v') args[0] = 'version';
	// `opal --port 9000` means the supervisor with flags, not a command named "--port".
	const [command, ...rest] = args[0] && !args[0].startsWith('--') ? args : ['supervise', ...args];
	const flags = FLAGS[command!];
	if (!flags) return { kind: 'error', message: `Unknown command: ${command}` };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (!a.startsWith('--')) continue;
		const takesValue = flags[a.slice(2)];
		if (takesValue === undefined) return { kind: 'error', message: `Unknown flag for ${command}: ${a}` };
		if (takesValue) {
			const value = rest[i + 1];
			if (value === undefined || value.startsWith('--')) return { kind: 'error', message: `${a} needs a value` };
			i++;
		}
	}
	return { kind: 'run', command: command!, args: rest };
}
