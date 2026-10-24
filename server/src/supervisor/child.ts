/** The server child process: lifecycle, log ring buffer and health polling. */

export type ChildState = 'stopped' | 'starting' | 'running' | 'crashed';

export interface ChildOptions {
	/** Command to run. A function, so a swapped binary is picked up on the next start. */
	command: () => string[];
	port: number;
	maxLines?: number;
	/** Time to wait for /api/health before the child counts as crashed. */
	healthTimeoutMs?: number;
	healthPollMs?: number;
	/** SIGTERM grace period before SIGKILL. */
	killAfterMs?: number;
	env?: Record<string, string | undefined>;
}

export class Child {
	state: ChildState = 'stopped';
	exitCode: number | null = null;
	startedAt: string | null = null;
	private lines: string[] = [];
	private proc: Bun.Subprocess | null = null;
	private stopping = false;
	private generation = 0;
	private readonly maxLines: number;

	constructor(private readonly opts: ChildOptions) {
		this.maxLines = opts.maxLines ?? 500;
	}

	get pid(): number | null {
		return this.proc?.pid ?? null;
	}

	get port(): number {
		return this.opts.port;
	}

	log(count = this.maxLines): string[] {
		return this.lines.slice(-count);
	}

	private push(source: string, text: string): void {
		for (const line of text.split(/\r?\n/)) {
			if (line === '') continue;
			this.lines.push(source === 'out' ? line : `[err] ${line}`);
		}
		if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
	}

	private async pump(stream: ReadableStream<Uint8Array> | undefined, source: string): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		let rest = '';
		try {
			for await (const chunk of stream) {
				rest += decoder.decode(chunk, { stream: true });
				const cut = rest.lastIndexOf('\n');
				if (cut >= 0) {
					this.push(source, rest.slice(0, cut));
					rest = rest.slice(cut + 1);
				}
			}
		} catch {
			// stream closed with the process
		}
		if (rest) this.push(source, rest);
	}

	start(): void {
		if (this.state === 'starting' || this.state === 'running') return;
		const gen = ++this.generation;
		this.stopping = false;
		this.exitCode = null;
		this.state = 'starting';
		this.startedAt = new Date().toISOString();
		let proc: Bun.Subprocess;
		try {
			proc = Bun.spawn(this.opts.command(), {
				stdout: 'pipe',
				stderr: 'pipe',
				stdin: 'ignore',
				env: { ...process.env, ...this.opts.env }
			});
		} catch (e) {
			this.push('err', `spawn failed: ${(e as Error).message}`);
			this.state = 'crashed';
			return;
		}
		this.proc = proc;
		void this.pump(proc.stdout as ReadableStream<Uint8Array>, 'out');
		void this.pump(proc.stderr as ReadableStream<Uint8Array>, 'err');
		void proc.exited.then((code) => {
			if (gen !== this.generation) return;
			this.proc = null;
			this.exitCode = code;
			if (this.stopping) {
				if (this.state !== 'crashed') this.state = 'stopped';
			} else {
				this.state = 'crashed';
				this.push('err', `server exited with code ${code}`);
			}
		});
		void this.pollHealth(gen);
	}

	private async pollHealth(gen: number): Promise<void> {
		const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 30_000);
		const every = this.opts.healthPollMs ?? 250;
		while (gen === this.generation && this.state === 'starting') {
			try {
				const res = await fetch(`http://127.0.0.1:${this.opts.port}/api/health`, {
					signal: AbortSignal.timeout(1000)
				});
				if (res.ok && gen === this.generation && this.state === 'starting') {
					this.state = 'running';
					return;
				}
			} catch {
				// not listening yet
			}
			if (Date.now() > deadline) {
				if (gen === this.generation && this.state === 'starting') {
					this.push('err', 'health check timed out');
					this.state = 'crashed';
					void this.kill();
				}
				return;
			}
			await Bun.sleep(every);
		}
	}

	/** Resolves true when the child is running, false when it crashed or the wait timed out. */
	async waitRunning(timeoutMs: number): Promise<boolean> {
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			if (this.state === 'running') return true;
			if (this.state === 'crashed' || this.state === 'stopped') return false;
			await Bun.sleep(50);
		}
		return this.state === 'running';
	}

	private async kill(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.stopping = true;
		proc.kill('SIGTERM');
		const timer = setTimeout(() => proc.kill('SIGKILL'), this.opts.killAfterMs ?? 5000);
		await proc.exited;
		clearTimeout(timer);
	}

	async stop(): Promise<void> {
		if (!this.proc) {
			this.state = 'stopped';
			return;
		}
		await this.kill();
		this.generation++;
		this.proc = null;
		this.state = 'stopped';
	}

	async restart(): Promise<void> {
		await this.stop();
		this.start();
	}
}

/** Port the server child listens on, from its arguments or the environment. */
export function childPort(args: string[]): number {
	const i = args.indexOf('--port');
	return Number((i >= 0 ? args[i + 1] : undefined) ?? process.env.OPAL_PORT ?? 8080);
}
