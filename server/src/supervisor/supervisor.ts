/** The supervisor: server child, update flow and control page wired together. */
import { Child, type ChildOptions } from './child.ts';
import { startControl, type Control } from './control.ts';
import {
	checkForUpdate,
	downloadUpdate,
	isCompiled,
	rollbackBinary,
	swapBinary,
	type UpdateInfo,
	type UpdaterOptions
} from './updater.ts';
import { VERSION } from '../version.ts';

export interface SupervisorOptions {
	controlPort: number;
	childPort: number;
	/** Command for the server child. Injectable for tests. */
	childCommand: () => string[];
	dataDir: string;
	binaryPath?: string;
	/** Defaults to {@link isCompiled}. */
	compiled?: boolean;
	version?: string;
	updater?: UpdaterOptions;
	child?: Partial<ChildOptions>;
	/** Health wait after an update before rolling back. */
	updateHealthMs?: number;
	exit?: (code: number) => void;
}

/** Command for the server child: the compiled binary re-runs itself; dev runs cli.ts under bun. */
export function defaultChildCommand(args: string[], compiled = isCompiled()): string[] {
	if (compiled) return [process.execPath, 'serve', ...args];
	return [process.execPath, new URL('../cli.ts', import.meta.url).pathname, 'serve', ...args];
}

export class Supervisor {
	readonly child: Child;
	readonly control: Control;
	private readonly version: string;
	private readonly compiled: boolean;
	private available: UpdateInfo | null = null;
	private checked = false;
	private busy: string | null = null;
	private updateError: string | null = null;

	constructor(private readonly opts: SupervisorOptions) {
		this.version = opts.version ?? VERSION;
		this.compiled = opts.compiled ?? isCompiled();
		this.child = new Child({ command: opts.childCommand, port: opts.childPort, ...opts.child });
		this.control = startControl(opts.controlPort, {
			status: () => this.status(),
			act: (a) => this.act(a)
		});
	}

	status() {
		return {
			state: this.child.state,
			pid: this.child.pid,
			exitCode: this.child.exitCode,
			startedAt: this.child.startedAt,
			version: this.version,
			port: this.opts.childPort,
			url: `http://127.0.0.1:${this.opts.childPort}`,
			dataDir: this.opts.dataDir,
			update: {
				available: this.available?.version ?? null,
				checked: this.checked,
				busy: this.busy,
				error: this.updateError
			},
			log: this.child.log(200)
		};
	}

	async act(action: string): Promise<{ ok: boolean; message?: string }> {
		switch (action) {
			case 'start':
				this.child.start();
				return { ok: true };
			case 'stop':
				await this.child.stop();
				return { ok: true };
			case 'restart':
				await this.child.restart();
				return { ok: true };
			case 'check':
				return this.check();
			case 'update':
				return this.applyUpdate();
			case 'quit':
				setTimeout(() => void this.quit(), 50);
				return { ok: true };
			default:
				return { ok: false, message: `unknown action ${action}` };
		}
	}

	async check(): Promise<{ ok: boolean; message: string }> {
		if (this.busy) return { ok: false, message: `Busy: ${this.busy}` };
		this.busy = 'checking';
		try {
			this.available = await checkForUpdate({ currentVersion: this.version, ...this.opts.updater });
			this.checked = true;
			this.updateError = null;
			return { ok: true, message: this.available ? `${this.available.version} available` : 'Up to date' };
		} catch (e) {
			this.updateError = (e as Error).message;
			return { ok: false, message: this.updateError };
		} finally {
			this.busy = null;
		}
	}

	/** Download, verify, swap, restart the child on the new binary. Roll back if it is not healthy. */
	async applyUpdate(): Promise<{ ok: boolean; message: string }> {
		if (this.busy) return { ok: false, message: `Busy: ${this.busy}` };
		if (!this.compiled || !this.opts.binaryPath) {
			this.updateError = 'Updates need the compiled opal binary; this is a development run.';
			return { ok: false, message: this.updateError };
		}
		const binary = this.opts.binaryPath;
		const updaterOpts = { currentVersion: this.version, ...this.opts.updater };
		try {
			this.busy = 'downloading';
			const info = this.available ?? (await checkForUpdate(updaterOpts));
			if (!info) {
				this.checked = true;
				return { ok: true, message: 'Up to date' };
			}
			const staged = await downloadUpdate(info, binary, updaterOpts);
			this.busy = 'installing';
			await this.child.stop();
			swapBinary(binary, staged);
			this.child.start();
			const healthy = await this.child.waitRunning(this.opts.updateHealthMs ?? 30_000);
			if (!healthy) {
				await this.child.stop();
				rollbackBinary(binary);
				this.child.start();
				throw new Error(`Server on ${info.version} failed its health check; restored the previous binary`);
			}
			this.available = null;
			this.updateError = null;
			return { ok: true, message: `Updated to ${info.version}. Restart OPAL to run the new supervisor.` };
		} catch (e) {
			this.updateError = (e as Error).message;
			return { ok: false, message: this.updateError };
		} finally {
			this.busy = null;
		}
	}

	async quit(): Promise<void> {
		await this.child.stop();
		this.control.stop();
		(this.opts.exit ?? process.exit)(0);
	}
}
