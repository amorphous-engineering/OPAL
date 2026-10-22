/**
 * Live state of one execution document.
 *
 * Loads the computed document from the API, keeps it current (a light /state
 * poll plus the SSE stream as an accelerator), and implements the controller
 * the procedure-doc components render against. Three rules shape it:
 *
 *  - Rows are never replaced under an operator: a refresh keeps the previous
 *    object for every OP and step whose data did not change, and data-capture
 *    drafts live here, outside the rows.
 *  - Expansion: everything is open until it is complete. A step or OP collapses
 *    when it reaches a terminal status, here or remotely; otherwise the
 *    operator's choice is kept (persisted per execution).
 *  - Presence is the explicit claim. Focus (keyboard cursor) is local only.
 */
import { api } from '#lib/api.js';
import { confirm, toast, toastError } from '#lib/components/opal/index.js';
import {
	isTerminal,
	visibleRows,
	type ConsumeItem,
	type DocActions,
	type DocController,
	type DocOp,
	type DocStep,
	type StockRecord
} from '#lib/components/procedure-doc/index.js';
import type { ExecutionDocument, ExecutionState } from './types.js';

const POLL_MS = 5000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function read<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* storage unavailable: the page works without it */
	}
}

/** Keys for every expandable thing: OP cards (`op:3`) and step bodies (`step:5`). */
export type OpenDialog =
	| { kind: 'skip'; step: DocStep }
	| { kind: 'issue'; step: DocStep }
	| { kind: 'redline'; op: DocOp; issueId?: number }
	| { kind: 'attach'; step: DocStep | null }
	| null;

export class ExecutionStore implements DocController {
	readonly mode = 'execute' as const;
	readonly id: number;
	viewerId: number | null;

	doc = $state<ExecutionDocument | null>(null);
	error = $state<string | null>(null);
	loading = $state(true);
	dialog = $state<OpenDialog>(null);
	focusedOrder = $state<number | null>(null);
	claimedOrder = $state<number | null>(null);
	/** Brief highlight after a jump (rail click, ?op= link). */
	pulse = $state<number | null>(null);

	private overrides = $state<Record<string, boolean>>({});
	private drafts = $state<Record<number, Record<string, unknown>>>({});
	private errors = $state<Record<number, Record<string, string>>>({});
	private stock: Record<number, StockRecord[]> = {};
	private statusByKey: Record<string, string> = {};
	private sig = '';
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private events: EventSource | undefined;
	private polling = false;
	private pollAgain = false;
	private stopped = false;

	constructor(id: number, viewerId: number | null) {
		this.id = id;
		this.viewerId = viewerId;
		this.overrides = read(this.key('open'), {});
		this.drafts = read(this.key('draft'), {});
	}

	private key(kind: string) {
		return `opal.exec.${this.id}.${kind}`;
	}
	private url(path = '') {
		return `/procedure-instances/${this.id}${path}`;
	}

	// ---------- derived ----------

	get active() {
		return this.doc?.instance.active ?? false;
	}

	get allOps(): DocOp[] {
		return this.doc ? [...this.doc.ops, ...this.doc.contingency_ops] : [];
	}

	findStep(order: number): { op: DocOp; step: DocStep } | undefined {
		for (const op of this.allOps) {
			if (op.step.order === order) return { op, step: op.step };
			const s = op.steps.find((x) => x.order === order);
			if (s) return { op, step: s };
		}
		return undefined;
	}

	// ---------- lifecycle ----------

	async start() {
		this.stopped = false;
		await this.refresh();
		this.loading = false;
		if (this.error) return;
		api.post(this.url('/join')).catch(() => {});
		this.pollTimer = setInterval(() => {
			if (document.visibilityState === 'visible') this.pollNow();
		}, POLL_MS);
		document.addEventListener('visibilitychange', this.onVisible);
		window.addEventListener('pagehide', this.leave);
		this.connectEvents();
	}

	stop() {
		this.stopped = true;
		clearInterval(this.pollTimer);
		this.events?.close();
		document.removeEventListener('visibilitychange', this.onVisible);
		window.removeEventListener('pagehide', this.leave);
		this.leave();
	}

	private onVisible = () => {
		if (document.visibilityState === 'visible') this.pollNow();
	};

	private leave = () => {
		try {
			navigator.sendBeacon(`/api${this.url('/leave')}`);
		} catch {
			/* presence is best-effort */
		}
	};

	/** SSE accelerates the poll: any event for this work order triggers one immediately. */
	private connectEvents() {
		if (typeof EventSource === 'undefined') return;
		const es = new EventSource('/api/events/stream');
		es.onmessage = (m) => {
			try {
				const ev = JSON.parse(m.data) as { type: string; data?: { instance_id?: number } };
				if (ev.data?.instance_id === this.id) this.pollNow();
			} catch {
				/* heartbeat or malformed frame */
			}
		};
		this.events = es;
	}

	// ---------- loading ----------

	async refresh() {
		try {
			const next = await api.get<ExecutionDocument>(this.url('/document'));
			this.applyDocument(next);
			this.error = null;
		} catch (e) {
			if (!this.doc) this.error = e instanceof Error ? e.message : 'Could not load execution';
			else if (!this.stopped) toastError(e);
		}
	}

	private applyDocument(next: ExecutionDocument) {
		const prevDoc = this.doc;
		// Terminal transitions: forget the operator's choice so the row collapses
		// (and so a reload agrees with what they saw).
		const seen: Record<string, string> = {};
		const note = (key: string, status: string) => {
			seen[key] = status;
			const before = this.statusByKey[key];
			if (before !== undefined && !isTerminal(before) && isTerminal(status)) {
				delete this.overrides[key];
				this.dropDraft(key);
			}
		};
		for (const op of [...next.ops, ...next.contingency_ops]) {
			note(`op:${op.order}`, op.status);
			note(`step:${op.step.order}`, op.step.status);
			for (const s of op.steps) note(`step:${s.order}`, s.status);
		}
		this.statusByKey = seen;
		write(this.key('open'), this.overrides);

		// Keep the previous object wherever nothing changed.
		const mergeOps = (nu: DocOp[], old: DocOp[] | undefined): DocOp[] =>
			nu.map((n) => {
				const o = old?.find((x) => x.order === n.order);
				if (!o) return n;
				if (same(o, n)) return o;
				const step = same(o.step, n.step) ? o.step : n.step;
				const steps = n.steps.map((s) => {
					const os = o.steps.find((x) => x.order === s.order);
					return os && same(os, s) ? os : s;
				});
				return { ...n, step, steps };
			});
		this.doc = {
			...next,
			ops: mergeOps(next.ops, prevDoc?.ops),
			contingency_ops: mergeOps(next.contingency_ops, prevDoc?.contingency_ops)
		};
		this.claimedOrder = next.my_cursor_order;
		if (this.focusedOrder === null) {
			this.focusedOrder = next.my_cursor_order ?? this.firstActionable()?.step.order ?? null;
		}
	}

	private dropDraft(key: string) {
		if (!key.startsWith('step:') && !key.startsWith('op:')) return;
		const order = Number(key.split(':')[1]);
		if (this.drafts[order]) {
			delete this.drafts[order];
			write(this.key('draft'), this.drafts);
		}
	}

	private firstActionable() {
		return visibleRows(this.allOps, () => true).find(
			(r) =>
				(r.step === r.op.step ? r.op.steps.length === 0 : true) &&
				(r.step.status === 'pending' || r.step.status === 'in_progress')
		);
	}

	// ---------- polling ----------

	async pollNow() {
		if (this.polling) {
			this.pollAgain = true;
			return;
		}
		this.polling = true;
		try {
			const state = await api.get<ExecutionState>(this.url('/state'));
			this.applyState(state);
		} catch {
			/* transient: the next tick retries */
		} finally {
			this.polling = false;
			if (this.pollAgain && !this.stopped) {
				this.pollAgain = false;
				this.pollNow();
			}
		}
	}

	/** The facts a refresh would change. Cursors and progress are applied without one. */
	private signature(s: ExecutionState) {
		return JSON.stringify([
			s.instance.status,
			s.steps.map((x) => [
				x.order,
				x.status,
				x.holds.map((h) => `${h.issue_number}:${h.disposition_state}:${h.kind}`),
				x.attachments,
				x.consumed,
				x.notes.length,
				x.notes.at(-1)?.id ?? null
			]),
			s.holds.map((h) => `${h.issue_number}:${h.disposition_state}`)
		]);
	}

	private async applyState(state: ExecutionState) {
		if (!this.doc) return;
		const sig = this.signature(state);
		if (this.sig === '') this.sig = sig;
		if (sig !== this.sig) {
			this.sig = sig;
			await this.refresh();
		}
		// Presence updates in place; they never rebuild a row.
		if (!same(this.doc.roster, state.roster)) this.doc.roster = state.roster;
		if (!same(this.doc.progress, state.instance.progress))
			this.doc.progress = state.instance.progress;
		for (const s of state.steps) {
			const found = this.findStep(s.order);
			if (found && !same(found.step.cursors, s.cursors)) found.step.cursors = s.cursors;
		}
		const me = state.roster.find((r) => r.user_id === this.viewerId);
		this.claimedOrder = me?.step_order ?? null;
	}

	/** After a local action: refetch now, and align the poll signature. */
	private async changed() {
		await this.refresh();
		await this.pollNow();
	}

	// ---------- controller: expansion & focus ----------

	isOpen(key: string, terminal: boolean): boolean {
		return this.overrides[key] ?? !terminal;
	}

	toggle(key: string, terminal: boolean) {
		const next = !this.isOpen(key, terminal);
		if (next === !terminal) delete this.overrides[key];
		else this.overrides[key] = next;
		write(this.key('open'), this.overrides);
	}

	setFocus(order: number) {
		this.focusedOrder = order;
	}

	/** Expand whatever hides `order`, then scroll to it. */
	jumpTo(order: number) {
		const hit = this.findStep(order);
		if (!hit) return;
		const { op, step } = hit;
		const opTerminal = isTerminal(op.status);
		if (!this.isOpen(`op:${op.order}`, opTerminal)) this.toggle(`op:${op.order}`, opTerminal);
		this.focusedOrder = order;
		this.pulse = order;
		setTimeout(() => {
			const el =
				document.getElementById(`step-${step.order}`) ?? document.getElementById(`op-${op.order}`);
			el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}, 30);
		setTimeout(() => (this.pulse = null), 1600);
	}

	// ---------- keyboard ----------

	/** j/k and arrows move the cursor, Enter toggles, c claims, n opens the note field. */
	handleKey(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
		if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
		const rows = visibleRows(this.allOps, (op) =>
			this.isOpen(`op:${op.order}`, isTerminal(op.status))
		);
		if (!rows.length) return;
		const idx = rows.findIndex((r) => r.step.order === this.focusedOrder);
		const move = (to: number) => {
			e.preventDefault();
			const r = rows[Math.min(rows.length - 1, Math.max(0, to))];
			this.focusedOrder = r.step.order;
			(
				document.getElementById(`step-${r.step.order}`) ??
				document.getElementById(`op-${r.op.order}`)
			)?.scrollIntoView({ block: 'nearest' });
		};
		if (e.key === 'j' || e.key === 'ArrowDown') return move(idx < 0 ? 0 : idx + 1);
		if (e.key === 'k' || e.key === 'ArrowUp') return move(idx < 0 ? rows.length - 1 : idx - 1);
		const cur = idx >= 0 ? rows[idx] : undefined;
		if (!cur) return;
		const isHeader = cur.step === cur.op.step;
		const leaf = cur.op.steps.length === 0;
		if (e.key === 'Enter') {
			e.preventDefault();
			if (isHeader || leaf) {
				this.toggle(`op:${cur.op.order}`, isTerminal(cur.op.status));
			} else {
				this.toggle(`step:${cur.step.order}`, isTerminal(cur.step.status));
			}
		} else if (e.key === 'c' && this.active && (!isHeader || leaf)) {
			e.preventDefault();
			if (this.claimedOrder === cur.step.order) this.actions.release?.();
			else this.actions.claim?.(cur.step);
		} else if (e.key === 'n' && (!isHeader || leaf)) {
			e.preventDefault();
			const order = cur.step.order;
			const open = () =>
				document.querySelector<HTMLInputElement>(`[data-note-input="${order}"]`)?.focus();
			if (!document.querySelector(`[data-note-input="${order}"]`)) {
				if (leaf) this.overrides[`op:${cur.op.order}`] = true;
				else this.overrides[`step:${order}`] = true;
				setTimeout(open, 50);
			} else open();
		}
	}

	// ---------- controller: data capture ----------

	fieldValue(step: DocStep, name: string): unknown {
		const d = this.drafts[step.order];
		if (d && name in d) return d[name];
		return step.data_captured?.[name];
	}

	setField(step: DocStep, name: string, value: unknown) {
		(this.drafts[step.order] ??= {})[name] = value;
		if (this.errors[step.order]?.[name]) delete this.errors[step.order][name];
		write(this.key('draft'), this.drafts);
	}

	fieldErrors(step: DocStep): Record<string, string> {
		return this.errors[step.order] ?? {};
	}

	private validate(step: DocStep): Record<string, string> {
		const out: Record<string, string> = {};
		for (const f of step.data_schema?.fields ?? []) {
			const v = this.fieldValue(step, f.name);
			const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
			if (f.required && f.type !== 'checkbox' && empty) out[f.name] = 'Required';
			else if (f.type === 'number' && !empty) {
				const n = Number(v);
				if (Number.isNaN(n)) out[f.name] = 'Not a number';
				else if (f.min !== undefined && f.min !== null && n < f.min)
					out[f.name] = `Below minimum ${f.min}`;
				else if (f.max !== undefined && f.max !== null && n > f.max)
					out[f.name] = `Above maximum ${f.max}`;
			}
		}
		return out;
	}

	private payload(step: DocStep): Record<string, unknown> | undefined {
		const fields = step.data_schema?.fields ?? [];
		if (!fields.length) return undefined;
		const data: Record<string, unknown> = {};
		for (const f of fields) {
			const v = this.fieldValue(step, f.name);
			if (f.type === 'checkbox') data[f.name] = !!v;
			else if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) data[f.name] = null;
			else data[f.name] = v;
		}
		return data;
	}

	// ---------- actions ----------

	actions: DocActions = {
		claim: async (step) => {
			try {
				await api.post(this.url('/focus'), { step_number: step.order });
				this.claimedOrder = step.order;
				await this.pollNow();
			} catch (e) {
				toastError(e, 'Could not claim step');
			}
		},
		release: async () => {
			try {
				await api.del(this.url('/focus'));
				this.claimedOrder = null;
				await this.pollNow();
			} catch (e) {
				toastError(e, 'Could not release claim');
			}
		},
		complete: async (step) => {
			const errs = this.validate(step);
			this.errors[step.order] = errs;
			if (Object.keys(errs).length) {
				toast.error(
					'Cannot complete: ' +
						Object.entries(errs)
							.map(([k, v]) => {
								const f = step.data_schema?.fields?.find((x) => x.name === k);
								return `${f?.label ?? k}: ${v.toLowerCase()}`;
							})
							.join('; ')
				);
				return;
			}
			try {
				const data = this.payload(step);
				await api.post(
					this.url(`/steps/${step.order}/complete`),
					data ? { data_captured: data } : {}
				);
				delete this.drafts[step.order];
				write(this.key('draft'), this.drafts);
				if (this.claimedOrder === step.order) await api.del(this.url('/focus')).catch(() => {});
				await this.changed();
				this.advanceFrom(step.order);
			} catch (e) {
				toastError(e, 'Failed to complete step');
				await this.refresh();
			}
		},
		signoff: async (step) => {
			try {
				await api.post(this.url(`/steps/${step.order}/signoff`));
				if (this.claimedOrder === step.order) await api.del(this.url('/focus')).catch(() => {});
				await this.changed();
			} catch (e) {
				toastError(e, 'Failed to sign off step');
			}
		},
		skip: (step) => (this.dialog = { kind: 'skip', step }),
		raiseIssue: (step) => (this.dialog = { kind: 'issue', step }),
		redline: (op) => (this.dialog = { kind: 'redline', op }),
		attach: (step) => (this.dialog = { kind: 'attach', step }),
		deleteRedline: async (op) => {
			if (
				!(await confirm({
					title: `Delete redline OP ${op.number}?`,
					body: 'The redline and its sub-steps are removed. Allowed only while no step has started.',
					action: 'DELETE',
					destructive: true
				}))
			)
				return;
			try {
				await api.del(this.url(`/ad-hoc-ops/${op.step.execution_id}`));
				await this.changed();
			} catch (e) {
				toastError(e, 'Failed to delete redline');
			}
		},
		addNote: async (step, body) => {
			try {
				await api.post(this.url(`/steps/${step.order}/notes`), { body });
				await this.changed();
				return true;
			} catch (e) {
				toastError(e, 'Failed to add note');
				return false;
			}
		},
		consume: async (step, items: ConsumeItem[]) => {
			try {
				await api.post(this.url(`/steps/${step.order}/consume`), { items });
				this.stock = {};
				await this.changed();
				return true;
			} catch (e) {
				toastError(e, 'Failed to consume parts');
				return false;
			}
		},
		loadStock: async (partId) => {
			if (this.stock[partId]) return this.stock[partId];
			const r = await api.get<{ items: StockRecord[] }>('/inventory', {
				part_id: partId,
				limit: 200
			});
			return (this.stock[partId] = r.items);
		},
		uploadPhotos: async (step, files) => {
			const ids: number[] = [];
			for (const file of files) {
				const fd = new FormData();
				fd.append('file', file);
				fd.append('step_execution_id', String(step.execution_id));
				fd.append('kind', 'capture');
				const att = await api.post<{ id: number }>('/attachments/upload', fd);
				ids.push(att.id);
			}
			return ids;
		},
		showEvidence: (step) => {
			const el = document.getElementById(`evidence-${step.order}`);
			el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			this.pulse = -step.order;
			setTimeout(() => (this.pulse = null), 1600);
		}
	};

	/** After COMPLETE, move the keyboard cursor to the next open step. */
	private advanceFrom(order: number) {
		const rows = visibleRows(this.allOps, (op) =>
			this.isOpen(`op:${op.order}`, isTerminal(op.status))
		).filter((r) => r.step !== r.op.step || r.op.steps.length === 0);
		const i = rows.findIndex((r) => r.step.order === order);
		const next = rows.slice(i + 1).find((r) => !isTerminal(r.step.status));
		if (next) this.focusedOrder = next.step.order;
	}

	// ---------- dialog operations ----------

	closeDialog() {
		this.dialog = null;
	}

	async skipStep(step: DocStep, reason: string) {
		await api.post(this.url(`/steps/${step.order}/skip`), { reason: reason.trim() || null });
		if (this.claimedOrder === step.order) await api.del(this.url('/focus')).catch(() => {});
		await this.changed();
	}

	async raiseIssue(
		step: DocStep,
		body: {
			title: string;
			description: string | null;
			priority: string;
			should_be: string | null;
			actual: string | null;
			containment: string;
			containment_step_number: number | null;
			assigned_to_id: number | null;
		},
		files: File[]
	) {
		const issue = await api.post<{ id: number; issue_number: string }>(
			this.url(`/steps/${step.order}/nc`),
			body
		);
		// Evidence at discovery links to the issue and the step.
		for (const file of files) {
			const fd = new FormData();
			fd.append('file', file);
			fd.append('issue_id', String(issue.id));
			fd.append('step_execution_id', String(step.execution_id));
			fd.append('kind', 'capture');
			await api.post('/attachments/upload', fd);
		}
		await this.changed();
		return issue;
	}

	async createRedline(body: {
		issue_id: number;
		title: string;
		steps: { title: string; instructions: string | null; requires_signoff: boolean }[];
	}) {
		await api.post(this.url('/ad-hoc-ops'), body);
		await this.changed();
	}

	async attachFiles(step: DocStep | null, files: File[], note: string, closeout: boolean) {
		for (const file of files) {
			const fd = new FormData();
			fd.append('file', file);
			if (step) fd.append('step_execution_id', String(step.execution_id));
			else fd.append('procedure_instance_id', String(this.id));
			fd.append('kind', !step && closeout ? 'closeout' : 'capture');
			if (note.trim()) fd.append('note', note.trim());
			await api.post('/attachments/upload', fd);
		}
		await this.changed();
	}

	async abort() {
		await api.patch(this.url(), { status: 'aborted' });
		await this.changed();
	}

	async update(body: Record<string, unknown>) {
		await api.patch(this.url(), body);
		await this.changed();
	}

	async consumeKit(items: { inventory_record_id: number; quantity: number }[]) {
		await api.post(this.url('/consume'), { items });
		this.stock = {};
		await this.changed();
	}

	async produce(
		items: {
			part_id: number;
			quantity: number;
			location: string;
			lot_number: string | null;
			serial_number: string | null;
		}[]
	) {
		await api.post(this.url('/produce'), { items });
		await this.changed();
	}

	async finalize(location: string) {
		await api.post(this.url('/finalize'), { location });
		await this.changed();
	}
}
