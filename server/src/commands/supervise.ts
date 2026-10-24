/** `opal` with no command: the supervisor and its local control page. */
import { dataDir } from '../paths.ts';
import { hasDisplay, openBrowser } from '../supervisor/browser.ts';
import { childPort } from '../supervisor/child.ts';
import { Supervisor, defaultChildCommand } from '../supervisor/supervisor.ts';
import { flag } from './args.ts';

export function supervise(args: string[]): void {
	// Flags for the supervisor itself are not passed on to the server.
	const controlPort = Number(flag(args, 'control-port') ?? 8079);
	const noBrowser = args.includes('--no-browser');
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === '--no-browser') continue;
		if (a === '--control-port') i++;
		else rest.push(a);
	}
	const sup = new Supervisor({
		controlPort,
		childPort: childPort(rest),
		childCommand: () => defaultChildCommand(rest),
		dataDir: dataDir(),
		binaryPath: process.execPath
	});
	sup.child.start();
	console.log(`OPAL control: ${sup.control.url}`);
	if (!noBrowser && hasDisplay()) openBrowser(sup.control.url);
	for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void sup.quit());
}
