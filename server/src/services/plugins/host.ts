/**
 * Runs enabled plugins as child processes (notes/plugin-system.md section 4).
 * One entry per plugin key. A generation number tells a late exit or health
 * callback that its process is already gone, so a restart never races a stop.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { now } from '@opal/shared';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { apiToken } from '../../db/schema/index.ts';
import { API_TOKEN_PREFIX, hashToken, newToken } from '../../auth/tokens.ts';
import { serialized } from '../../registry.ts';
import { insert, update } from '../../write.ts';
import type { PluginProcess, PluginRuntime } from './runtime.ts';
import { codeDir, findPlugin, pluginDataDir, settingValues, type PluginRow } from './store.ts';

export interface HostOptions {
	maxLines?: number;
	healthTimeoutMs?: number;
	healthPollMs?: number;
	/** SIGTERM grace period before SIGKILL. */
	killAfterMs?: number;
	backoffStartMs?: number;
	backoffMaxMs?: number;
	/** A process that ran this long starts the backoff over. */
	backoffResetMs?: number;
}

interface Entry {
	gen: number;
	state: PluginProcess['state'];
	proc: Bun.Subprocess | null;
	port: number | null;
	pid: number | null;
	startedAt: string | null;
	runningSince: number | null;
	restarts: number;
	exitCode: number | null;
	lines: string[];
	backoff: number;
	timer: ReturnType<typeof setTimeout> | null;
	userId: number | null;
}

const systemCtx = (db: Db): Ctx => ({ db, actor: { kind: 'system' }, op: 'plugins.host' });

export class PluginHost implements PluginRuntime {
	private entries = new Map<string, Entry>();
	/** Queued token revokes, so stopAll can wait for them. */
	private pending = new Set<Promise<unknown>>();

	constructor(
		private readonly db: Db,
		private readonly opts: HostOptions = {}
	) {}

	private o() {
		return {
			maxLines: this.opts.maxLines ?? 500,
			healthTimeoutMs: this.opts.healthTimeoutMs ?? 15_000,
			healthPollMs: this.opts.healthPollMs ?? 200,
			killAfterMs: this.opts.killAfterMs ?? 5000,
			backoffStartMs: this.opts.backoffStartMs ?? 1000,
			backoffMaxMs: this.opts.backoffMaxMs ?? 300_000,
			backoffResetMs: this.opts.backoffResetMs ?? 600_000
		};
	}

	private entry(key: string): Entry {
		let e = this.entries.get(key);
		if (!e) {
			e = {
				gen: 0,
				state: 'stopped',
				proc: null,
				port: null,
				pid: null,
				startedAt: null,
				runningSince: null,
				restarts: 0,
				exitCode: null,
				lines: [],
				backoff: this.o().backoffStartMs,
				timer: null,
				userId: null
			};
			this.entries.set(key, e);
		}
		return e;
	}

	port(key: string): number | null {
		const e = this.entries.get(key);
		return e?.state === 'running' ? e.port : null;
	}

	process(key: string): PluginProcess {
		const e = this.entries.get(key);
		if (!e) return { state: 'stopped', pid: null, startedAt: null, restarts: 0, exitCode: null };
		return { state: e.state, pid: e.pid, startedAt: e.startedAt, restarts: e.restarts, exitCode: e.exitCode };
	}

	log(key: string): string[] {
		return [...(this.entries.get(key)?.lines ?? [])];
	}

	private push(e: Entry, source: 'out' | 'err', text: string): void {
		const at = now();
		for (const line of text.split(/\r?\n/)) {
			if (line === '') continue;
			e.lines.push(source === 'out' ? `${at} ${line}` : `${at} [err] ${line}`);
		}
		const max = this.o().maxLines;
		if (e.lines.length > max) e.lines.splice(0, e.lines.length - max);
	}

	private async pump(e: Entry, stream: ReadableStream<Uint8Array> | undefined, source: 'out' | 'err'): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		let rest = '';
		try {
			for await (const chunk of stream) {
				rest += decoder.decode(chunk, { stream: true });
				const cut = rest.lastIndexOf('\n');
				if (cut >= 0) {
					this.push(e, source, rest.slice(0, cut));
					rest = rest.slice(cut + 1);
				}
			}
		} catch {
			// the stream closes with the process
		}
		if (rest) this.push(e, source, rest);
	}

	async start(key: string): Promise<void> {
		try {
			const row = findPlugin(this.db, key);
			if (!row?.enabled) return;
			const e = this.entry(key);
			await this.halt(e);
			e.restarts = 0;
			e.backoff = this.o().backoffStartMs;
			await this.launch(key, e.gen);
		} catch (err) {
			console.error(`Plugin ${key} failed to start: ${(err as Error).message}`);
		}
	}

	/** Kills the process, cancels a pending restart and invalidates its callbacks. */
	private async halt(e: Entry): Promise<void> {
		e.gen++;
		if (e.timer) clearTimeout(e.timer);
		e.timer = null;
		const proc = e.proc;
		e.proc = null;
		if (proc) {
			proc.kill('SIGTERM');
			const t = setTimeout(() => proc.kill('SIGKILL'), this.o().killAfterMs);
			e.exitCode = await proc.exited;
			clearTimeout(t);
		}
		e.state = 'stopped';
		e.port = null;
		e.pid = null;
		e.runningSince = null;
	}

	/** Mints the token, spawns the process and watches it. `gen` is the generation that owns this run. */
	private async launch(key: string, gen: number): Promise<void> {
		const e = this.entry(key);
		const row = findPlugin(this.db, key);
		if (!row?.enabled) {
			e.state = 'stopped';
			return;
		}
		e.state = 'starting';
		e.userId = row.userId;
		const port = await freePort();
		const raw = newToken(API_TOKEN_PREFIX);
		// Waits for the write queue. Callers run start() fire-and-forget, never inside the queue.
		await serialized(async () => mintToken(this.db, row, raw));
		if (e.gen !== gen) return;
		const data = pluginDataDir(key);
		mkdirSync(data, { recursive: true });
		let proc: Bun.Subprocess;
		try {
			proc = Bun.spawn([process.execPath, join(codeDir(row), row.manifest.main)], {
				cwd: codeDir(row),
				stdout: 'pipe',
				stderr: 'pipe',
				stdin: 'ignore',
				env: {
					...process.env,
					BUN_BE_BUN: '1',
					OPAL_URL: `http://127.0.0.1:${process.env.OPAL_PORT ?? 8080}`,
					OPAL_TOKEN: raw,
					OPAL_PLUGIN_ID: key,
					OPAL_PLUGIN_PORT: String(port),
					OPAL_PLUGIN_DATA: data,
					OPAL_SETTINGS: JSON.stringify(settingValues(this.db, row))
				}
			});
		} catch (err) {
			this.push(e, 'err', `spawn failed: ${(err as Error).message}`);
			e.state = 'crashed';
			this.scheduleRestart(key, e, gen);
			return;
		}
		e.proc = proc;
		e.port = port;
		e.pid = proc.pid;
		e.startedAt = now();
		e.exitCode = null;
		void this.pump(e, proc.stdout as ReadableStream<Uint8Array>, 'out');
		void this.pump(e, proc.stderr as ReadableStream<Uint8Array>, 'err');
		void proc.exited.then((code) => {
			if (e.gen !== gen) return;
			e.proc = null;
			e.exitCode = code;
			e.pid = null;
			e.port = null;
			e.state = 'crashed';
			this.push(e, 'err', `process exited with code ${code}`);
			if (e.runningSince !== null && Date.now() - e.runningSince >= this.o().backoffResetMs) {
				e.backoff = this.o().backoffStartMs;
			}
			e.runningSince = null;
			this.scheduleRestart(key, e, gen);
		});
		void this.pollHealth(e, gen, port);
	}

	private scheduleRestart(key: string, e: Entry, gen: number): void {
		const delay = e.backoff;
		e.backoff = Math.min(e.backoff * 2, this.o().backoffMaxMs);
		e.timer = setTimeout(() => {
			e.timer = null;
			if (e.gen !== gen) return;
			e.restarts++;
			void this.launch(key, gen).catch((err) => console.error(`Plugin ${key} restart failed: ${(err as Error).message}`));
		}, delay);
	}

	private async pollHealth(e: Entry, gen: number, port: number): Promise<void> {
		const o = this.o();
		const deadline = Date.now() + o.healthTimeoutMs;
		while (e.gen === gen && e.state === 'starting') {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/__health`, { signal: AbortSignal.timeout(1000) });
				if (res.ok && e.gen === gen && e.state === 'starting') {
					e.state = 'running';
					e.runningSince = Date.now();
					return;
				}
			} catch {
				// not listening yet
			}
			if (Date.now() > deadline) {
				if (e.gen === gen && e.state === 'starting') {
					this.push(e, 'err', 'health check timed out');
					// The exit handler marks it crashed and schedules the restart.
					const proc = e.proc;
					proc?.kill('SIGTERM');
					setTimeout(() => proc?.kill('SIGKILL'), o.killAfterMs).unref();
				}
				return;
			}
			await Bun.sleep(o.healthPollMs);
		}
	}

	async stop(key: string): Promise<void> {
		const e = this.entry(key);
		const userId = findPlugin(this.db, key)?.userId ?? e.userId;
		await this.halt(e);
		if (userId !== null) this.queueRevoke(userId);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.entries.keys()].map((k) => this.stop(k)));
		await Promise.allSettled([...this.pending]);
	}

	/** Not awaited by stop(): stop runs inside write operations that hold the queue. */
	private queueRevoke(userId: number): void {
		const p = serialized(async () => revokeTokens(this.db, userId)).catch(() => undefined);
		this.pending.add(p);
		void p.finally(() => this.pending.delete(p));
	}
}

function revokeTokens(db: Db, userId: number): void {
	const ctx = systemCtx(db);
	const live = db
		.select({ id: apiToken.id })
		.from(apiToken)
		.where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)))
		.all();
	for (const t of live) update(ctx, apiToken, t.id, { revokedAt: now() });
}

function mintToken(db: Db, row: PluginRow, raw: string): void {
	revokeTokens(db, row.userId);
	insert(systemCtx(db), apiToken, {
		userId: row.userId,
		name: `plugin:${row.key}`,
		tokenHash: hashToken(raw),
		scopes: {
			ops: [...row.manifest.permissions.ops, 'auth.me', 'plugins.links.*'],
			events: row.manifest.permissions.events
		}
	});
}

async function freePort(): Promise<number> {
	const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
	const port = s.port!;
	await s.stop(true);
	return port;
}
