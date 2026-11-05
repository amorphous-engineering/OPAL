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
 *  - Expansion: only the current step of the current OP opens by default, and that
 *    moves as the work does. Whatever the person opened stays open until it finishes
 *    or they close it (persisted per execution). A step with values typed in stays open.
 *  - Presence is the explicit claim. Focus (keyboard cursor) is local only.
 */
import type { ExecutionComment } from '@opal/shared';
import { api, opal } from '#lib/api.js';
import { toast, toastError } from '#lib/components/opal/index.js';
import {
	isActionable,
	isTerminal,
	visibleRows,
	type ConsumeItem,
	type DocActions,
	type DocController,
	type DocLabor,
	type DocOp,
	type DocStep,
	type StockRecord
} from '#lib/components/procedure-doc/index.js';
import { adaptDocument, adaptState } from './adapt.js';
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

/** The one form open on the page. It sits inline: nothing here covers the document. */
export type OpenPanel =
	{ kind: 'redline'; op: DocOp; issueId?: number } | { kind: 'closeShort' } | null;

type WorkRow = { op: DocOp; step: DocStep };

export class ExecutionStore implements DocController {
	readonly mode = 'execute' as const;
	readonly id: number;
	viewerId: number | null;

	doc = $state<ExecutionDocument | null>(null);
	error = $state<string | null>(null);
	loading = $state(true);
	panel = $state<OpenPanel>(null);
	focusedOrder = $state<number | null>(null);
	claimedOrder = $state<number | null>(null);
	/** Brief highlight after a jump (rail click, ?op= link). */
	pulse = $state<number | null>(null);
	/** The work order's comment thread, oldest first. Null until loaded. */
	comments = $state<ExecutionComment[] | null>(null);

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
		this.overrides = read(this.key('opened'), {});
		this.drafts = read(this.key('draft'), {});
	}

	private key(kind: string) {
		return `opal.exec.${this.id}.${kind}`;
	}

	// ---------- derived ----------

	get active() {
		return this.doc?.instance.active ?? false;
	}

	get struck() {
		return !!this.doc?.instance.closure;
	}

	get allOps(): DocOp[] {
		return this.doc ? [...this.doc.ops, ...this.doc.contingency_ops] : [];
	}

	laborFor(opOrder: number): DocLabor[] {
		return this.doc?.labor.filter((l) => l.op_order === opOrder) ?? [];
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
		// The first poll sets the baseline signature. Take it now, so a hold raised in the first
		// seconds (from another tab, say) reads as a change and not as where the page started.
		await this.pollNow();
		void this.loadComments();
		opal.execution.join({ id: this.id }).catch(() => {});
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
			navigator.sendBeacon(`/api/executions/${this.id}/leave`);
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
				const ev = JSON.parse(m.data) as { type: string; data?: { executionId?: number } };
				if (ev.data?.executionId !== this.id) return;
				if (ev.type === 'execution_comment') void this.loadComments();
				else this.pollNow();
			} catch {
				/* heartbeat or malformed frame */
			}
		};
		this.events = es;
	}

	// ---------- comments ----------

	async loadComments() {
		try {
			this.comments = await opal.execution.listComments({ id: this.id });
		} catch (e) {
			if (!this.stopped) toastError(e);
		}
	}

	/** True when the comment was saved (the caller then clears its input). */
	async addComment(body: string): Promise<boolean> {
		try {
			const c = await opal.execution.addComment({ id: this.id, body });
			// The event reloads the thread too; adding here shows it without waiting.
			if (this.comments && !this.comments.some((x) => x.id === c.id))
				this.comments = [...this.comments, c];
			return true;
		} catch (e) {
			toastError(e, 'Comment not saved');
			return false;
		}
	}

	// ---------- loading ----------

	async refresh() {
		try {
			const next = adaptDocument(await opal.execution.document({ id: this.id }));
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
		write(this.key('opened'), this.overrides);

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

	/** Rows that take work: a leaf OP, the sub-steps of an OP, and an OP waiting on its own sign-off. */
	private workRows(ops: DocOp[]): WorkRow[] {
		return ops.flatMap((op) => {
			if (!op.steps.length) return [{ op, step: op.step }];
			const rows = op.steps.map((step) => ({ op, step }));
			return op.step.status === 'awaiting_signoff' ? [...rows, { op, step: op.step }] : rows;
		});
	}

	/**
	 * The step that opens by default: the first this person can act on in the OP they claimed, else
	 * in the document. With nothing to act on, the first unfinished one, which answers what is
	 * stopping the work. Contingency work is optional, so it opens only once someone claims it.
	 * Clicking around does not move this, so opening one step never closes another.
	 */
	openOrder = $derived.by(() => {
		const doc = this.doc;
		if (!doc?.instance.active) return null;
		const ready = (r: WorkRow) => isActionable(r.step) || r.step.signoffs.some((s) => s.can_sign);
		const pick = (rows: WorkRow[]) =>
			rows.find(ready) ?? rows.find((r) => !isTerminal(r.step.status));
		const claimed = this.workRows(this.allOps.filter((o) => o.order === this.claimedOrder));
		return (pick(claimed) ?? pick(this.workRows(doc.ops)))?.step.order ?? null;
	});

	/** The one accent on the page: the focused step if it can be worked, else the step that opened. */
	currentOrder = $derived.by(() => {
		if (!this.doc?.instance.active) return null;
		const focused = this.workRows(this.allOps).find((r) => r.step.order === this.focusedOrder);
		if (focused && isActionable(focused.step)) return focused.step.order;
		return this.openOrder;
	});

	/** Focus mode: show only the OP selected in the sidebar, hide the rest. Remembered per browser. */
	focusMode = $state(read<boolean>('opal.exec.focusMode', false));
	private focusOverride = $state<number | null>(null);

	/** The OP focus mode shows: selected in the sidebar, else the claimed OP, else the OP
	 *  of the current step. */
	get focusOp(): number | null {
		if (this.focusOverride !== null) return this.focusOverride;
		if (this.claimedOrder !== null) return this.claimedOrder;
		const cur = this.currentOrder;
		return cur === null ? null : (this.findStep(cur)?.op.order ?? null);
	}
	set focusOp(order: number | null) {
		this.focusOverride = order;
	}

	/** The OPs the document renders: all of them, or only the focused one in focus mode. */
	get shownOps(): DocOp[] {
		const all = this.allOps;
		if (!this.focusMode) return all;
		const only = all.filter((o) => o.order === this.focusOp);
		return only.length ? only : all;
	}

	setFocusMode(on: boolean) {
		this.focusMode = on;
		this.focusOverride = null;
		write('opal.exec.focusMode', on);
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
			const state = adaptState(await opal.execution.state({ id: this.id }));
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
				x.notes
			]),
			s.holds.map((h) => `${h.issue_number}:${h.disposition_state}`),
			s.issue_count
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
		if (!same(this.doc.labor, state.labor)) this.doc.labor = state.labor;
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

	private defaultOpen(key: string): boolean {
		const order = this.openOrder;
		const hit = order === null ? undefined : this.findStep(order);
		if (hit && (key === `step:${order}` || key === `op:${hit.op.order}`)) return true;
		// Values typed into a step never close under the operator.
		const [kind, id] = key.split(':');
		if (kind === 'step') return !!this.drafts[Number(id)];
		const op = this.allOps.find((o) => o.order === Number(id));
		return !!op && [op.step, ...op.steps].some((s) => this.drafts[s.order]);
	}

	isOpen(key: string): boolean {
		return this.overrides[key] ?? this.defaultOpen(key);
	}

	toggle(key: string) {
		const next = !this.isOpen(key);
		if (next === this.defaultOpen(key)) delete this.overrides[key];
		else this.overrides[key] = next;
		write(this.key('opened'), this.overrides);
	}

	setFocus(order: number) {
		this.focusedOrder = order;
	}

	/** Expand whatever hides `order`, then scroll to it. */
	jumpTo(order: number) {
		const hit = this.findStep(order);
		if (!hit) return;
		const { op, step } = hit;
		// Focus mode: jumping selects the OP, which hides every other one.
		if (this.focusMode) this.focusOp = op.order;
		if (!this.isOpen(`op:${op.order}`)) this.toggle(`op:${op.order}`);
		if (step.order !== op.order && !this.isOpen(`step:${step.order}`)) {
			this.toggle(`step:${step.order}`);
		}
		this.focusedOrder = order;
		this.pulse = order;
		setTimeout(() => {
			const el =
				document.getElementById(`step-${step.order}`) ?? document.getElementById(`op-${op.order}`);
			// An OP lands at the top of the pane (its steps follow); a step is centred.
			el?.scrollIntoView({ behavior: 'smooth', block: order === op.order ? 'start' : 'center' });
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
		const rows = visibleRows(this.shownOps, (op) => this.isOpen(`op:${op.order}`));
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
				this.toggle(`op:${cur.op.order}`);
			} else {
				this.toggle(`step:${cur.step.order}`);
			}
		} else if (e.key === 'c' && this.active) {
			// Claims are per OP: c claims (or releases) the OP the cursor is in.
			e.preventDefault();
			if (this.claimedOrder === cur.op.order) this.actions.release?.();
			else this.actions.claim?.(cur.op.step);
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
			if (f.required && empty) out[f.name] = 'Required';
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
			if (f.type === 'boolean') data[f.name] = typeof v === 'boolean' ? v : null;
			else if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) data[f.name] = null;
			else data[f.name] = v;
		}
		return data;
	}

	// ---------- actions ----------

	actions: DocActions = {
		claim: async (step) => {
			try {
				const r = await opal.execution.focus({ id: this.id, stepId: step.order });
				this.claimedOrder = r.stepId; // the OP the claim covers
				await this.pollNow();
			} catch (e) {
				toastError(e, 'Could not claim operation');
			}
		},
		release: async () => {
			try {
				await opal.execution.release({ id: this.id });
				this.claimedOrder = null;
				await this.pollNow();
			} catch (e) {
				toastError(e, 'Could not release claim');
			}
		},
		sign: async (step, slot) => {
			// Slot 0 is COMPLETE: it carries the captured data and its validation.
			let data: Record<string, unknown> | undefined;
			if (slot === 0) {
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
				data = this.payload(step);
			}
			try {
				await opal.execution.sign({
					id: this.id,
					stepId: step.order,
					slot,
					dataCaptured: data ?? null
				});
				if (slot === 0) {
					delete this.drafts[step.order];
					write(this.key('draft'), this.drafts);
				}
				await this.changed();
				const now = this.findStep(step.order)?.step;
				if (now && isTerminal(now.status)) {
					if (this.claimedOrder === step.order)
						await opal.execution.release({ id: this.id }).catch(() => {});
					this.advanceFrom(step.order);
				}
			} catch (e) {
				toastError(e, 'Step not recorded');
				await this.refresh();
			}
		},
		skip: async (step, reason) => {
			try {
				await opal.execution.skip({ id: this.id, stepId: step.order, reason });
				if (this.claimedOrder === step.order)
					await opal.execution.release({ id: this.id }).catch(() => {});
				await this.changed();
				return true;
			} catch (e) {
				toastError(e, 'Step not skipped');
				return false;
			}
		},
		issueHref: (step) => this.issueUrl(step),
		redline: (op) => (this.panel = { kind: 'redline', op }),
		deleteRedline: async (op) => {
			try {
				await opal.execution.deleteRedline({ id: this.id, redlineId: op.step.execution_id! });
				await this.changed();
			} catch (e) {
				toastError(e, 'Failed to delete redline');
			}
		},
		addNote: async (step, body, files = []) => {
			try {
				const note = await opal.execution.addNote({ id: this.id, stepId: step.order, body });
				for (const file of files) {
					const fd = new FormData();
					fd.append('file', file);
					fd.append('ownerType', 'step_note');
					fd.append('ownerId', String(note.id));
					await api.post('/attachments', fd);
				}
				await this.changed();
				return true;
			} catch (e) {
				toastError(e, 'Failed to add note');
				// The note may already exist; show it rather than invite a duplicate.
				await this.changed().catch(() => {});
				return false;
			}
		},
		consume: async (step, items: ConsumeItem[]) => {
			try {
				await opal.execution.consumeAtStep({
					id: this.id,
					stepId: step.order,
					items: items.map((i) => ({
						stockId: i.inventory_record_id,
						quantity: String(i.quantity),
						usage: i.usage_type === 'tooling' ? ('tooling' as const) : ('consume' as const)
					}))
				});
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
			// Oldest first: the picker defaults to the first record.
			const r = await opal.inventory.list({
				partId,
				hasStock: 'true',
				sort: 'createdAt',
				order: 'asc',
				limit: 200
			});
			return (this.stock[partId] = r.items.map((x) => ({
				id: x.id,
				part_id: x.partId,
				part_name: x.partName,
				part_uom: x.partUom,
				quantity: x.balance,
				location: x.location,
				lot_number: x.lotNumber,
				opal_number: x.opalNumber
			})));
		},
		uploadPhotos: async (step, files) => {
			const ids: number[] = [];
			for (const file of files) {
				const fd = new FormData();
				fd.append('file', file);
				fd.append('ownerType', 'step_execution');
				fd.append('ownerId', String(step.execution_id));
				fd.append('kind', 'capture');
				const att = await api.post<{ id: number }>('/attachments', fd);
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

	/** After the step completes, move the keyboard cursor to the next open step. */
	private advanceFrom(order: number) {
		const rows = visibleRows(this.shownOps, (op) => this.isOpen(`op:${op.order}`)).filter(
			(r) => r.step !== r.op.step || r.op.steps.length === 0
		);
		const i = rows.findIndex((r) => r.step.order === order);
		const next = rows.slice(i + 1).find((r) => !isTerminal(r.step.status));
		if (next) this.focusedOrder = next.step.order;
	}

	// ---------- panel operations ----------

	closePanel() {
		this.panel = null;
	}

	/** The issue form with this work order, and the step if there is one, carried in the URL. */
	issueUrl(step?: DocStep): string {
		const inst = this.doc?.instance;
		const label = encodeURIComponent(inst?.work_order ?? '');
		const at = step ? `&step=${step.order}&stepLabel=${encodeURIComponent(step.number)}` : '';
		return `/issues/new?execution=${this.id}&executionLabel=${label}&projectId=${inst?.project.id ?? ''}${at}`;
	}

	async createRedline(body: {
		issueId: number;
		title: string;
		steps: { title: string; instructions: string | null; requiresSignoff: boolean }[];
	}) {
		await opal.execution.createRedline({ id: this.id, ...body });
		await this.changed();
	}

	async voidOrder(reason: string) {
		await opal.execution.void({ id: this.id, reason });
		await this.changed();
	}

	async closeShort(reason: string, issueId: number) {
		await opal.execution.closeShort({ id: this.id, reason, issueId });
		await this.changed();
	}

	async update(body: Omit<Parameters<typeof opal.execution.update>[0], 'id'>) {
		await opal.execution.update({ id: this.id, ...body });
		await this.changed();
	}

	async consumeKit(items: { inventory_record_id: number; quantity: number }[]) {
		await opal.execution.consume({
			id: this.id,
			items: items.map((i) => ({
				stockId: i.inventory_record_id,
				quantity: String(i.quantity),
				usage: 'consume' as const
			}))
		});
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
		await opal.execution.produce({
			id: this.id,
			items: items.map((i) => ({
				partId: i.part_id,
				quantity: String(i.quantity),
				location: i.location,
				lotNumber: i.lot_number,
				serialNumber: i.serial_number
			}))
		});
		await this.changed();
	}

	async finalize(location: string) {
		await opal.execution.finalize({ id: this.id, location });
		await this.changed();
	}
}
