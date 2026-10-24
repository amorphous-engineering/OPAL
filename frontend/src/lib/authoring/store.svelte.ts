/**
 * Live state of one procedure draft in the template editor.
 *
 * Implements the procedure-doc DocController in author mode. Rules:
 *
 *  - Local state is the truth while the author types. Edits apply to the
 *    document objects immediately and autosave in the background; a refetch
 *    never overwrites a field with an unsent or in-flight edit.
 *  - DocStep/DocOp objects are persistent reactive objects, mutated in place,
 *    so editing one field re-renders only what reads it (a 90-step template
 *    stays smooth). Their `order` is the template step id: stable across
 *    renumbering, so expansion, focus and DOM ids survive structural edits.
 *  - Structure (add, delete, duplicate, move) flushes pending edits, calls the
 *    API, then reloads the draft; numbering is whatever the API says.
 *  - Last write wins. A light poll compares the server draft with what this
 *    editor holds; when someone else changed it, a banner offers a refresh.
 */
/* eslint-disable svelte/prefer-svelte-reactivity -- the maps and sets here are bookkeeping, never rendered */
import { api, opal } from '#lib/api.js';
import { confirm, toastError } from '#lib/components/opal/index.js';
import type {
	AuthorActions,
	Callout,
	DocActions,
	DocController,
	DocOp,
	DocSignoff,
	DocStep,
	PartHit,
	SaveState,
	StepEdit,
	WorkcenterOption
} from '#lib/components/procedure-doc/index.js';
import type { DraftStep } from './types.js';
import {
	formatQty,
	parseQty,
	type ProcedureDataField,
	type ProcedureStepImage,
	type Qty
} from '@opal/shared';

/** A quantity the editor shows as a number, from the wire decimal. */
const toNum = (q: string) => Number(q);
/** The wire decimal for a number typed in the editor (at most 4 places). */
const toQty = (n: number) => formatQty(Math.round(n * 10000) as Qty);
void parseQty;

const TEXT_DELAY = 700;
const POLL_MS = 20000;
/** Templates up to this many steps open every step body by default. */
const SMALL_DOC = 12;

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
		/* storage unavailable: the editor works without it */
	}
}

const norm = (v: string | null | undefined) => (v ? v : null);

/** The callouts the server keeps: trimmed text, empty boxes dropped. */
const keptCallouts = (v: Callout[] | null | undefined): Callout[] =>
	(v ?? []).map((c) => ({ kind: c.kind, text: c.text.trim() })).filter((c) => c.text);

/** The definitions as unsigned slots, for the preview's sign-off table. */
const previewSlots = (defs: { label: string; role: string | null }[]): DocSignoff[] =>
	defs.map((d, slot) => ({
		slot,
		label: d.label,
		role: d.role ?? null,
		signed_by: null,
		signed_at: null,
		can_sign: true,
		blockers: []
	}));

interface Job {
	key: string;
	stepId: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	state: SaveState;
	error: string | null;
	version: number;
	run: () => Promise<void>;
	chain: Promise<void>;
}

/** Document fields of a step that mirror onto its OP. */
const OP_MIRROR = ['title', 'instructions', 'callouts', 'is_contingency'] as const;

export class AuthorStore implements DocController {
	readonly mode = 'author' as const;
	readonly procedureId: number;
	viewerId: number | null = null;
	active = false;

	doc = $state<{ ops: DocOp[]; contingency: DocOp[] }>({ ops: [], contingency: [] });
	loading = $state(true);
	error = $state<string | null>(null);
	/** A structural call is running; structure controls wait. */
	busy = $state(false);
	focusedOrder = $state<number | null>(null);
	claimedOrder: number | null = null;
	/** Server draft that differs from this editor's (someone else edited). */
	stale = $state<DraftStep[] | null>(null);
	savedAt = $state<number | null>(null);
	summary = $state({ dirty: 0, saving: 0, error: 0 });
	/** Sub-step count and OP count, for the host's page. */
	counts = $state({ ops: 0, steps: 0 });
	workcenters = $state<WorkcenterOption[]>([]);
	drag = $state<{
		id: number | null;
		over: { id: number; pos: 'before' | 'after' | 'into' } | null;
	}>({ id: null, over: null });
	/** Brief highlight after a jump. */
	pulse = $state<number | null>(null);

	private overrides = $state<Record<string, boolean>>({});
	private stepSave = $state<Record<number, { state: SaveState; error: string | null }>>({});
	private byId = new Map<number, DocStep>();
	private opById = new Map<number, DocOp>();
	private pending = new Map<number, StepEdit>();
	private inflight = new Map<number, StepEdit>();
	private jobs = new Map<string, Job>();
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;
	private smallDoc = true;
	private leafIds = new Set<number>();
	private onchange: () => void;
	private changeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(procedureId: number, onchange: () => void = () => {}) {
		this.procedureId = procedureId;
		this.onchange = onchange;
		this.overrides = read(this.key('open'), {});
	}

	private key(kind: string) {
		return `opal.author.${this.procedureId}.${kind}`;
	}
	private url(path = '') {
		return `/procedures/${this.procedureId}${path}`;
	}

	// ---------- lifecycle ----------

	async start() {
		this.stopped = false;
		await Promise.all([this.reload(true), this.loadWorkcenters()]);
		this.loading = false;
		this.pollTimer = setInterval(() => {
			if (document.visibilityState === 'visible') this.poll();
		}, POLL_MS);
		document.addEventListener('visibilitychange', this.onVisibility);
		window.addEventListener('beforeunload', this.onBeforeUnload);
	}

	stop() {
		this.stopped = true;
		clearInterval(this.pollTimer);
		clearTimeout(this.changeTimer);
		document.removeEventListener('visibilitychange', this.onVisibility);
		window.removeEventListener('beforeunload', this.onBeforeUnload);
		// Unsent edits go out; the editor is leaving.
		void this.flushAll();
	}

	private onVisibility = () => {
		if (document.visibilityState === 'hidden') void this.flushAll();
		else this.poll();
	};

	private onBeforeUnload = (e: BeforeUnloadEvent) => {
		if (this.summary.dirty || this.summary.saving || this.summary.error) {
			void this.flushAll();
			e.preventDefault();
		}
	};

	private async loadWorkcenters() {
		try {
			this.workcenters = await opal.org.workcenters.list({});
		} catch {
			/* optional picker: the editor works without it */
		}
	}

	// ---------- loading ----------

	private async fetchDraft(): Promise<DraftStep[]> {
		return (await opal.procedures.draft({ id: this.procedureId })).steps;
	}

	async reload(initial = false) {
		try {
			this.reconcile(await this.fetchDraft());
			this.stale = null;
			this.error = null;
		} catch (e) {
			if (initial) this.error = e instanceof Error ? e.message : 'Could not load the template';
			else toastError(e);
		}
	}

	/** Apply the server's draft without disturbing fields the author has unsent edits in. */
	private reconcile(draft: DraftStep[]) {
		const dirty = (id: number, k: keyof StepEdit) =>
			(this.pending.get(id) && k in this.pending.get(id)!) ||
			(this.inflight.get(id) && k in this.inflight.get(id)!);

		const ids = new Set(draft.map((d) => d.id));
		for (const id of [...this.byId.keys()]) {
			if (!ids.has(id)) {
				this.byId.delete(id);
				this.opById.delete(id);
				this.pending.delete(id);
			}
		}
		const numberOf = new Map(draft.map((d) => [d.id, d.number]));
		const kidsOf = new Map<number, number>();
		for (const d of draft)
			if (d.parentId !== null) kidsOf.set(d.parentId, (kidsOf.get(d.parentId) ?? 0) + 1);
		this.leafIds = new Set(
			draft.filter((d) => d.parentId === null && !kidsOf.has(d.id)).map((d) => d.id)
		);
		this.smallDoc = draft.length <= SMALL_DOC;

		for (const d of draft) {
			let st = this.byId.get(d.id);
			if (!st) {
				const fresh: DocStep = $state(this.blank(d));
				st = fresh;
				this.byId.set(d.id, st);
			}
			st.number = d.number;
			st.level = d.level;
			st.is_op = d.parentId === null;
			st.parent_order = d.parentId;
			const set = <K extends keyof StepEdit>(k: K, field: keyof DocStep, v: unknown) => {
				if (dirty(d.id, k)) return;
				const cur = (st as unknown as Record<string, unknown>)[field as string];
				const same =
					typeof v === 'string' || v === null || cur === ''
						? norm(cur as string) === norm(v as string)
						: cur === v;
				if (!same) (st as unknown as Record<string, unknown>)[field as string] = v;
			};
			set('title', 'title', d.title);
			set('instructions', 'instructions', d.instructions);
			if (
				!dirty(d.id, 'callouts') &&
				JSON.stringify(keptCallouts(st.callouts)) !== JSON.stringify(keptCallouts(d.callouts))
			)
				st.callouts = (d.callouts ?? []).map((c) => ({ ...c }));
			if (!dirty(d.id, 'signoffs')) {
				set('role', 'role', d.requiredRole);
				set('requires_signoff', 'requires_signoff', d.requiresSignoff);
				const defs = (d.signoffs ?? []).map((x) => ({ label: x.label, role: x.role ?? null }));
				if (JSON.stringify(st.signoff_defs ?? []) !== JSON.stringify(defs)) {
					st.signoff_defs = defs;
					st.signoffs = previewSlots(defs);
					st.signoffs = previewSlots(defs);
				}
			}
			set('estimated_duration_minutes', 'estimated_duration_minutes', d.estimatedDurationMinutes);
			set('is_contingency', 'is_contingency', d.isContingency);
			set('workcenter_id', 'workcenter_id', d.workcenterId);
			if (
				!dirty(d.id, 'data_schema') &&
				JSON.stringify(st.data_schema) !== JSON.stringify(d.dataSchema)
			)
				st.data_schema = d.dataSchema;
			const images = d.images.map((i) => ({
				id: i.id,
				attachment_id: i.attachmentId,
				sha256: i.sha256,
				caption: i.caption
			}));
			if (JSON.stringify(st.images) !== JSON.stringify(images)) st.images = images;
			const kit = d.kit.map((k) => ({
				id: k.id,
				part_id: k.partId,
				part_name: k.partName,
				part_number: k.partNumber,
				quantity_required: toNum(k.quantity),
				usage_type: k.usage,
				notes: k.notes
			}));
			if (JSON.stringify(st.step_kit) !== JSON.stringify(kit)) st.step_kit = kit;
		}

		const build = (group: DraftStep[]): DocOp[] =>
			group.map((d) => {
				const st = this.byId.get(d.id)!;
				const subs = draft.filter((x) => x.parentId === d.id).map((x) => this.byId.get(x.id)!);
				let op = this.opById.get(d.id);
				if (!op) {
					const fresh: DocOp = $state(this.blankOp(st));
					op = fresh;
					this.opById.set(d.id, op);
				}
				op.number = d.number;
				op.title = st.title;
				op.instructions = st.instructions;
				op.callouts = st.callouts;
				op.role = st.role;
				op.is_contingency = st.is_contingency;
				if (
					!(this.pending.get(d.id) && 'strict_sequence' in this.pending.get(d.id)!) &&
					!(this.inflight.get(d.id) && 'strict_sequence' in this.inflight.get(d.id)!)
				)
					op.strict_sequence = d.strictSequence;
				op.depends_on = d.dependsOn;
				op.waiting_on_ops = d.dependsOn.map((x) => numberOf.get(x) ?? '?');
				op.progress = { done: 0, total: subs.length };
				op.step = st;
				const same = op.steps.length === subs.length && op.steps.every((s, i) => s === subs[i]);
				if (!same) op.steps = subs;
				return op;
			});
		const tops = draft.filter((d) => d.parentId === null);
		const ops = build(tops.filter((d) => !d.isContingency));
		const contingency = build(tops.filter((d) => d.isContingency));
		const sameList = (a: DocOp[], b: DocOp[]) =>
			a.length === b.length && a.every((x, i) => x === b[i]);
		if (!sameList(this.doc.ops, ops)) this.doc.ops = ops;
		if (!sameList(this.doc.contingency, contingency)) this.doc.contingency = contingency;
		this.counts = { ops: tops.length, steps: draft.length - tops.length };
		if (this.focusedOrder !== null && !this.byId.has(this.focusedOrder)) this.focusedOrder = null;
	}

	private blank(d: DraftStep): DocStep {
		return {
			order: d.id,
			id: d.id,
			number: d.number,
			title: d.title,
			level: d.level,
			is_op: d.parentId === null,
			parent_order: d.parentId,
			status: 'pending',
			instructions: d.instructions,
			callouts: (d.callouts ?? []).map((c) => ({ ...c })),
			role: d.requiredRole,
			requires_signoff: d.requiresSignoff,
			is_contingency: d.isContingency,
			estimated_duration_minutes: d.estimatedDurationMinutes,
			workcenter_id: d.workcenterId,
			images: [],
			step_kit: [],
			data_schema: d.dataSchema,
			data_captured: null,
			skip_reason: null,
			completed: null,
			signed_off: null,
			cursors: [],
			holds: [],
			issue_history: [],
			complete_blockers: [],
			skip_blockers: [],
			notes: [],
			signoffs: previewSlots(d.signoffs ?? []),
			signoff_defs: (d.signoffs ?? []).map((x) => ({ label: x.label, role: x.role ?? null })),
			attachments: [],
			consumptions: [],
			waiting: null
		};
	}

	private blankOp(step: DocStep): DocOp {
		return {
			order: step.order,
			number: step.number,
			title: step.title,
			status: 'pending',
			instructions: step.instructions,
			callouts: step.callouts,
			role: step.role,
			strict_sequence: false,
			is_contingency: step.is_contingency,
			is_ad_hoc: false,
			redline: null,
			waiting_on_ops: [],
			depends_on: [],
			holds: [],
			open_ncs: [],
			progress: { done: 0, total: 0 },
			step,
			steps: []
		};
	}

	// ---------- derived ----------

	get allOps(): DocOp[] {
		return [...this.doc.ops, ...this.doc.contingency];
	}

	ops = () => this.allOps;

	findStep(order: number): { op: DocOp; step: DocStep } | undefined {
		for (const op of this.allOps) {
			if (op.step.order === order) return { op, step: op.step };
			const s = op.steps.find((x) => x.order === order);
			if (s) return { op, step: s };
		}
		return undefined;
	}

	/** One word for the toolbar: what saving is doing right now. */
	get status(): SaveState {
		if (this.summary.error) return 'error';
		if (this.summary.saving) return 'saving';
		if (this.summary.dirty) return 'dirty';
		return this.savedAt ? 'saved' : 'idle';
	}

	// ---------- saving ----------

	private refreshSummary(stepId?: number) {
		const s = { dirty: 0, saving: 0, error: 0 };
		for (const j of this.jobs.values()) {
			if (j.state === 'dirty') s.dirty++;
			else if (j.state === 'saving') s.saving++;
			else if (j.state === 'error') s.error++;
		}
		this.summary = s;
		if (stepId !== undefined) {
			let state: SaveState = 'idle';
			let error: string | null = null;
			const rank: Record<SaveState, number> = { idle: 0, saved: 1, dirty: 2, saving: 3, error: 4 };
			for (const j of this.jobs.values()) {
				if (j.stepId !== stepId) continue;
				if (rank[j.state] > rank[state]) {
					state = j.state;
					error = j.error;
				}
			}
			this.stepSave[stepId] = { state, error };
		}
	}

	/** (Re)schedule a save. `run` reads the latest pending data when it executes. */
	private schedule(key: string, stepId: number, delay: number, run: () => Promise<void>) {
		let job = this.jobs.get(key);
		if (!job) {
			job = {
				key,
				stepId,
				timer: undefined,
				state: 'idle',
				error: null,
				version: 0,
				run,
				chain: Promise.resolve()
			};
			this.jobs.set(key, job);
		}
		job.run = run;
		job.version++;
		job.state = 'dirty';
		job.error = null;
		clearTimeout(job.timer);
		if (delay <= 0) this.runJob(job);
		else job.timer = setTimeout(() => this.runJob(job), delay);
		this.refreshSummary(stepId);
	}

	private runJob(job: Job): Promise<void> {
		clearTimeout(job.timer);
		job.timer = undefined;
		job.chain = job.chain.then(async () => {
			const started = job.version;
			job.state = 'saving';
			this.refreshSummary(job.stepId);
			try {
				await job.run();
				if (job.version === started) {
					job.state = 'saved';
					this.savedAt = Date.now();
					this.jobs.delete(job.key);
					this.noteChanged();
				}
			} catch (e) {
				job.state = 'error';
				job.error = e instanceof Error ? e.message : 'Save failed';
				if (job.version !== started) job.state = 'dirty';
			}
			this.refreshSummary(job.stepId);
			if (job.state === 'saved')
				this.stepSave[job.stepId] = { state: this.summaryFor(job.stepId), error: null };
		});
		return job.chain;
	}

	private summaryFor(stepId: number): SaveState {
		for (const j of this.jobs.values()) if (j.stepId === stepId) return j.state;
		return 'saved';
	}

	/** Tell the host the draft changed (it refreshes "unpublished changes"), debounced. */
	private noteChanged() {
		clearTimeout(this.changeTimer);
		this.changeTimer = setTimeout(() => this.onchange(), 800);
	}

	async flushAll() {
		const running: Promise<void>[] = [];
		for (const job of this.jobs.values()) running.push(this.runJob(job));
		await Promise.all(running);
	}

	async retry() {
		const failed = [...this.jobs.values()].filter((j) => j.state === 'error');
		await Promise.all(failed.map((j) => this.runJob(j)));
	}

	stepState = (step: DocStep): SaveState => this.stepSave[step.order]?.state ?? 'idle';
	stepError = (step: DocStep): string | null => this.stepSave[step.order]?.error ?? null;

	// ---------- editing ----------

	private apiBody(patch: StepEdit) {
		const body: Omit<Parameters<typeof opal.procedures.steps.update>[0], 'id' | 'stepId'> = {};
		if ('title' in patch) body.title = patch.title;
		if ('instructions' in patch) body.instructions = norm(patch.instructions);
		if ('callouts' in patch) body.callouts = keptCallouts(patch.callouts);
		if ('role' in patch && !('signoffs' in patch)) body.requiredRole = norm(patch.role);
		if ('requires_signoff' in patch && !('signoffs' in patch))
			body.requiresSignoff = patch.requires_signoff;
		if ('signoffs' in patch)
			body.signoffs = patch.signoffs ? patch.signoffs.map((x) => ({ role: norm(x.role) })) : null;
		if ('estimated_duration_minutes' in patch)
			body.estimatedDurationMinutes = patch.estimated_duration_minutes ?? null;
		if ('is_contingency' in patch) body.isContingency = patch.is_contingency;
		if ('strict_sequence' in patch) body.strictSequence = patch.strict_sequence;
		if ('workcenter_id' in patch) body.workcenterId = patch.workcenter_id ?? null;
		if ('data_schema' in patch) {
			const fields = patch.data_schema?.fields ?? [];
			body.dataSchema = fields.length ? { fields: fields as ProcedureDataField[] } : null;
		}
		return body;
	}

	edit = (step: DocStep, patch: StepEdit) => {
		const st = this.byId.get(step.order);
		if (!st) return;
		const op = this.opById.get(st.order);
		const apply = { ...patch };
		if ('title' in apply && !(apply.title ?? '').trim()) {
			// Local only: the API refuses an empty title. Say so where the author is looking.
			st.title = apply.title ?? '';
			delete apply.title;
			this.stepSave[st.order] = { state: 'error', error: 'A title is required' };
		}
		// Typing inside a callout debounces; add, remove and kind changes save at once.
		const sameShape =
			'callouts' in apply &&
			(apply.callouts ?? []).length === st.callouts.length &&
			(apply.callouts ?? []).every((c, i) => c.kind === st.callouts[i].kind);
		const s = st as unknown as Record<string, unknown>;
		const keys = Object.keys(apply) as (keyof StepEdit)[];
		if (!keys.length) return;
		for (const k of keys) {
			if (k === 'signoffs') continue;
			s[k] = apply[k];
		}
		if ('signoffs' in apply) {
			const defs = (apply.signoffs ?? []).map((x) => ({ label: x.label, role: x.role ?? null }));
			st.signoff_defs = defs;
			st.signoffs = previewSlots(defs);
			// The legacy facts are derived from the list: slot 0's role; a second slot
			// (a leaf) or any slot (an OP with sub-steps) means sign-off is required.
			const hasKids = !!op && op.steps.length > 0;
			st.role = defs[0]?.role ?? null;
			st.requires_signoff = hasKids ? defs.length > 0 : defs.length > 1;
			if (op) op.role = st.role;
		}
		if (op) {
			for (const k of OP_MIRROR)
				if (k in apply) (op as unknown as Record<string, unknown>)[k] = apply[k];
			if ('role' in apply) op.role = apply.role ?? null;
			if ('strict_sequence' in apply) op.strict_sequence = !!apply.strict_sequence;
		}
		const merged = { ...(this.pending.get(st.order) ?? {}), ...apply };
		this.pending.set(st.order, merged);
		const textual =
			sameShape ||
			keys.some((k) =>
				['title', 'instructions', 'role', 'signoffs', 'estimated_duration_minutes'].includes(k)
			);
		this.schedule(`step:${st.order}`, st.order, textual ? TEXT_DELAY : 0, () =>
			this.saveStep(st.order)
		);
	};

	private async saveStep(id: number) {
		const patch = this.pending.get(id);
		if (!patch) return;
		this.pending.delete(id);
		this.inflight.set(id, patch);
		try {
			const r = await opal.procedures.steps.update({
				id: this.procedureId,
				stepId: id,
				...this.apiBody(patch)
			});
			this.inflight.delete(id);
			const st = this.byId.get(id);
			if (st && r.number) st.number = r.number;
			if ('is_contingency' in patch) await this.reload();
		} catch (e) {
			this.inflight.delete(id);
			// Keep what was typed: back into pending, under anything newer.
			this.pending.set(id, { ...patch, ...(this.pending.get(id) ?? {}) });
			throw e;
		}
	}

	// ---------- structure ----------

	private async structure<T>(fn: () => Promise<T>): Promise<T | undefined> {
		if (this.busy) return undefined;
		this.busy = true;
		try {
			await this.flushAll();
			const out = await fn();
			await this.reload();
			this.noteChanged();
			return out;
		} catch (e) {
			toastError(e);
			await this.reload();
			return undefined;
		} finally {
			this.busy = false;
		}
	}

	focusTitle(order: number) {
		this.focusedOrder = order;
		setTimeout(() => {
			const el = document.querySelector<HTMLInputElement>(`[data-title-input="${order}"]`);
			el?.focus();
			el?.select();
			el?.scrollIntoView({ block: 'nearest' });
		}, 40);
	}

	addOp = async (opts: { after?: DocOp; contingency?: boolean } = {}) => {
		const made = await this.structure(() =>
			opal.procedures.steps.add({
				id: this.procedureId,
				title: 'New operation',
				afterStepId: opts.after?.order,
				isContingency: opts.after ? opts.after.is_contingency : !!opts.contingency
			})
		);
		if (made) this.focusTitle(made.id);
	};

	addStep = async (op: DocOp, after: DocStep) => {
		const made = await this.structure(() =>
			opal.procedures.steps.add({
				id: this.procedureId,
				title: 'New step',
				parentId: op.order,
				afterStepId: after.order
			})
		);
		if (made) {
			delete this.overrides[`op:${op.order}`];
			this.overrides[`op:${op.order}`] = true;
			this.focusTitle(made.id);
		}
	};

	remove = async (step: DocStep) => {
		const hit = this.findStep(step.order);
		if (!hit) return;
		const isOp = hit.op.step === step;
		const n = isOp ? hit.op.steps.length : 0;
		const ok = await confirm({
			title: `Delete ${isOp ? 'OP' : 'step'} ${step.number}${step.title ? ` ${step.title}` : ''}?`,
			body: isOp
				? `${n ? `Its ${n} ${n === 1 ? 'step' : 'steps'} go with it. ` : ''}Parts, images and data fields on it are removed. Published versions keep their copy.`
				: 'Its parts, images and data fields are removed. Published versions keep their copy.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		const neighbour = this.neighbourOf(step);
		this.pending.delete(step.order);
		const job = this.jobs.get(`step:${step.order}`);
		if (job) {
			clearTimeout(job.timer);
			this.jobs.delete(job.key);
			this.refreshSummary(step.order);
		}
		const done = await this.structure(async () => {
			await opal.procedures.steps.remove({ id: this.procedureId, stepId: step.order });
			return true;
		});
		if (done) this.focusedOrder = neighbour;
	};

	duplicate = async (step: DocStep) => {
		const made = await this.structure(() =>
			opal.procedures.steps.duplicate({ id: this.procedureId, stepId: step.order })
		);
		// Focus the copy's row, not its title: a bare key after D (X deletes) must not edit the text.
		if (made) {
			this.focusedOrder = made.id;
			setTimeout(() => {
				const id = made.id;
				(
					document.getElementById(`step-${id}`) ?? document.getElementById(`op-${id}`)
				)?.scrollIntoView({ block: 'nearest' });
			}, 40);
		}
	};

	move = async (step: DocStep, direction: -1 | 1) => {
		const hit = this.findStep(step.order);
		if (!hit) return;
		if (hit.op.step === step) {
			const group = step.is_contingency ? this.doc.contingency : this.doc.ops;
			const i = group.findIndex((o) => o.step === step);
			const j = i + direction;
			if (j < 0 || j >= group.length) return;
			await this.moveTo(step, null, j);
			return;
		}
		const subs = hit.op.steps;
		const i = subs.indexOf(step);
		const j = i + direction;
		if (j >= 0 && j < subs.length) return this.moveTo(step, hit.op, j);
		// Past the edge: cross into the neighbouring OP.
		const group = hit.op.is_contingency ? this.doc.contingency : this.doc.ops;
		const k = group.indexOf(hit.op) + direction;
		const next = group[k];
		if (!next) return;
		await this.moveTo(step, next, direction < 0 ? next.steps.length : 0);
	};

	moveTo = async (step: DocStep, parent: DocOp | null, index: number) => {
		const moved = await this.structure(() =>
			opal.procedures.steps.move({
				id: this.procedureId,
				stepId: step.order,
				parentId: parent ? parent.order : null,
				index,
				...(parent === null ? { isContingency: step.is_contingency } : {})
			})
		);
		if (moved !== undefined) {
			this.focusedOrder = step.order;
			setTimeout(
				() => document.getElementById(`step-${step.order}`)?.scrollIntoView({ block: 'nearest' }),
				40
			);
		}
	};

	/** Resolve a drop (row + side) into a move. */
	dropOn = async (target: { id: number; pos: 'before' | 'after' | 'into' }) => {
		const srcId = this.drag.id;
		this.drag = { id: null, over: null };
		if (srcId === null || srcId === target.id) return;
		const src = this.findStep(srcId);
		const dst = this.findStep(target.id);
		if (!src || !dst) return;
		const srcIsOp = src.op.step === src.step;
		const dstIsOp = dst.op.step === dst.step;
		if (srcIsOp) {
			// OPs reorder among OPs; a drop on a sub-step means "next to its OP".
			const targetOp = dst.op;
			if (targetOp === src.op) return;
			const group = (targetOp.is_contingency ? this.doc.contingency : this.doc.ops).filter(
				(o) => o !== src.op
			);
			const at = group.indexOf(targetOp) + (target.pos === 'before' ? 0 : 1);
			const moved = await this.structure(() =>
				opal.procedures.steps.move({
					id: this.procedureId,
					stepId: srcId,
					parentId: null,
					index: at,
					isContingency: targetOp.is_contingency
				})
			);
			if (moved !== undefined) this.focusedOrder = srcId;
			return;
		}
		if (dstIsOp) {
			// Onto an OP: the end of its steps.
			const count = dst.op.steps.filter((s) => s !== src.step).length;
			return this.moveTo(src.step, dst.op, count);
		}
		const siblings = dst.op.steps.filter((s) => s !== src.step);
		const at = siblings.indexOf(dst.step) + (target.pos === 'before' ? 0 : 1);
		return this.moveTo(src.step, dst.op, at);
	};

	private neighbourOf(step: DocStep): number | null {
		const rows = this.rows();
		const i = rows.findIndex((r) => r.step === step);
		return (rows[i + 1] ?? rows[i - 1])?.step.order ?? null;
	}

	setDependencies = async (op: DocOp, onIds: number[]) => {
		const before = op.depends_on ?? [];
		op.depends_on = onIds;
		op.waiting_on_ops = onIds.map((id) => this.opById.get(id)?.number ?? '?');
		try {
			await opal.procedures.steps.setDependencies({
				id: this.procedureId,
				stepId: op.order,
				dependsOn: onIds
			});
			this.noteChanged();
		} catch (e) {
			op.depends_on = before;
			op.waiting_on_ops = before.map((id) => this.opById.get(id)?.number ?? '?');
			toastError(e);
		}
	};

	// ---------- images ----------

	private track(stepId: number, label: string, run: () => Promise<void>) {
		return this.runTracked(`${label}:${stepId}`, stepId, run);
	}

	private async runTracked(key: string, stepId: number, run: () => Promise<void>) {
		const job: Job = {
			key: `${key}:${Math.random()}`,
			stepId,
			timer: undefined,
			state: 'saving',
			error: null,
			version: 0,
			run,
			chain: Promise.resolve()
		};
		this.jobs.set(job.key, job);
		this.refreshSummary(stepId);
		try {
			await run();
			this.savedAt = Date.now();
			this.noteChanged();
		} catch (e) {
			toastError(e);
		} finally {
			this.jobs.delete(job.key);
			this.refreshSummary(stepId);
		}
	}

	addImages = async (step: DocStep, files: File[]) => {
		const images = files.filter((f) => f.type.startsWith('image/'));
		if (!images.length) return;
		await this.track(step.order, 'img', async () => {
			for (const file of images) {
				const fd = new FormData();
				fd.append('file', file);
				const r = await api.post<ProcedureStepImage>(this.url(`/steps/${step.order}/images`), fd);
				step.images = [
					...step.images,
					{ id: r.id, attachment_id: r.attachmentId, sha256: r.sha256, caption: r.caption }
				];
			}
		});
	};

	setCaption = (step: DocStep, imageId: number, caption: string) => {
		const img = step.images.find((i) => i.id === imageId);
		if (!img) return;
		img.caption = caption;
		this.schedule(`cap:${imageId}`, step.order, TEXT_DELAY, async () => {
			await opal.procedures.steps.images.update({
				id: this.procedureId,
				stepId: step.order,
				imageId,
				caption: caption.trim() || null
			});
		});
	};

	removeImage = async (step: DocStep, imageId: number) => {
		await this.track(step.order, 'imgdel', async () => {
			await opal.procedures.steps.images.remove({
				id: this.procedureId,
				stepId: step.order,
				imageId
			});
			step.images = step.images.filter((i) => i.id !== imageId);
		});
	};

	moveImage = async (step: DocStep, imageId: number, direction: -1 | 1) => {
		const list = [...step.images];
		const i = list.findIndex((x) => x.id === imageId);
		const j = i + direction;
		if (i < 0 || j < 0 || j >= list.length) return;
		[list[i], list[j]] = [list[j], list[i]];
		const before = step.images;
		step.images = list;
		await this.track(step.order, 'imgorder', async () => {
			try {
				await opal.procedures.steps.images.reorder({
					id: this.procedureId,
					stepId: step.order,
					imageIds: list.map((x) => x.id!)
				});
			} catch (e) {
				step.images = before;
				throw e;
			}
		});
	};

	// ---------- step parts ----------

	addKit = async (
		step: DocStep,
		part: PartHit,
		quantity: number,
		usage: string,
		notes: string | null
	) => {
		await this.track(step.order, 'kit', async () => {
			const r = await opal.procedures.steps.kit.add({
				id: this.procedureId,
				stepId: step.order,
				partId: part.id,
				quantity: toQty(quantity),
				usage: usage as 'consume' | 'tooling',
				notes
			});
			step.step_kit = [
				...step.step_kit,
				{
					id: r.id,
					part_id: part.id,
					part_name: part.name,
					part_number: part.internal_pn,
					quantity_required: quantity,
					usage_type: usage,
					notes
				}
			];
		});
	};

	editKit = (
		step: DocStep,
		kitId: number,
		patch: { quantity_required?: number; usage_type?: string; notes?: string | null }
	) => {
		const line = step.step_kit.find((k) => k.id === kitId);
		if (!line) return;
		Object.assign(line, patch);
		this.schedule(`kit:${step.order}:${kitId}`, step.order, TEXT_DELAY, async () => {
			if (!(line.quantity_required > 0)) throw new Error('Quantity must be above zero');
			await opal.procedures.steps.kit.update({
				id: this.procedureId,
				stepId: step.order,
				kitId,
				quantity: toQty(line.quantity_required),
				usage: line.usage_type as 'consume' | 'tooling',
				notes: line.notes ?? null
			});
		});
	};

	removeKit = async (step: DocStep, kitId: number) => {
		const line = step.step_kit.find((k) => k.id === kitId);
		if (!line) return;
		await this.track(step.order, 'kitdel', async () => {
			await opal.procedures.steps.kit.remove({
				id: this.procedureId,
				stepId: step.order,
				kitId
			});
			step.step_kit = step.step_kit.filter((k) => k.id !== kitId);
		});
	};

	uploadInline = async (file: File): Promise<string> => {
		const fd = new FormData();
		fd.append('file', file);
		fd.append('ownerType', 'procedure');
		fd.append('ownerId', String(this.procedureId));
		fd.append('kind', 'inline');
		const r = await api.post<{ id: number }>('/attachments', fd);
		const alt = file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
		return `![${alt}](/api/attachments/${r.id}/download)`;
	};

	// ---------- other editors ----------

	private async poll() {
		if (this.stopped || this.busy || this.stale) return;
		if (this.jobs.size || this.pending.size || this.inflight.size) return;
		try {
			const server = await this.fetchDraft();
			if (this.jobs.size || this.busy) return;
			if (this.fingerprint(server) !== this.localFingerprint(server)) this.stale = server;
		} catch {
			/* transient: the next tick retries */
		}
	}

	private canon(d: DraftStep): unknown[] {
		const fields = d.dataSchema?.fields ?? [];
		return [
			d.id,
			d.number,
			d.parentId,
			d.title,
			norm(d.instructions),
			keptCallouts(d.callouts),
			(d.signoffs ?? []).map((x) => [x.label, norm(x.role)]),
			d.estimatedDurationMinutes ?? null,
			d.isContingency,
			d.strictSequence,
			d.workcenterId ?? null,
			fields.length ? JSON.stringify(d.dataSchema) : null,
			[...d.dependsOn].sort(),
			d.images.map((i) => [i.id, norm(i.caption)]),
			d.kit.map((k) => [k.id, toNum(k.quantity), k.usage, norm(k.notes)])
		];
	}

	private fingerprint(draft: DraftStep[]): string {
		return JSON.stringify(draft.map((d) => this.canon(d)));
	}

	/** What this editor holds, in the canonical form of the server's steps and in its order. */
	private localFingerprint(server: DraftStep[]): string {
		// A step the server lacks (deleted elsewhere) or one we lack: lengths differ.
		if (this.byId.size !== server.length) return 'length-differs';
		const local: unknown[][] = [];
		for (const s of server) {
			const st = this.byId.get(s.id);
			if (!st) return 'length-differs';
			const op = this.opById.get(s.id);
			const fields = st.data_schema?.fields ?? [];
			local.push([
				st.order,
				st.number,
				st.parent_order,
				st.title,
				norm(st.instructions),
				keptCallouts(st.callouts),
				(st.signoff_defs ?? []).map((x) => [x.label, norm(x.role)]),
				st.estimated_duration_minutes ?? null,
				st.is_contingency,
				op ? op.strict_sequence : s.strictSequence,
				st.workcenter_id ?? null,
				fields.length ? JSON.stringify(st.data_schema) : null,
				[...(op?.depends_on ?? [])].sort(),
				st.images.map((i) => [i.id, norm(i.caption)]),
				st.step_kit.map((k) => [k.id, k.quantity_required, k.usage_type, norm(k.notes)])
			]);
		}
		return JSON.stringify(local);
	}

	/** Take the other editor's version (nothing local is unsent when this is offered). */
	async refreshFromServer() {
		if (this.stale) this.reconcile(this.stale);
		this.stale = null;
		this.onchange();
	}

	// ---------- controller: expansion & focus ----------

	isOpen(key: string): boolean {
		const o = this.overrides[key];
		if (o !== undefined) return o;
		if (key.startsWith('op:')) {
			const id = Number(key.slice(3));
			return this.leafIds.has(id) ? this.smallDoc : true;
		}
		return this.smallDoc;
	}

	toggle(key: string, terminal: boolean) {
		void terminal;
		this.overrides[key] = !this.isOpen(key);
		write(this.key('open'), this.overrides);
	}

	setAllOpen(open: boolean) {
		const next: Record<string, boolean> = {};
		for (const op of this.allOps) {
			next[`op:${op.order}`] = open || op.steps.length > 0 ? open : open;
			for (const s of op.steps) next[`step:${s.order}`] = open;
			if (!op.steps.length) next[`op:${op.order}`] = open;
		}
		// Collapsing keeps OP cards open so the structure stays visible.
		if (!open) for (const op of this.allOps) if (op.steps.length) next[`op:${op.order}`] = true;
		this.overrides = next;
		write(this.key('open'), this.overrides);
	}

	setFocus(order: number) {
		this.focusedOrder = order;
	}

	// ---------- focus mode (one OP at a time) ----------

	focusMode = $state(read<boolean>('opal.author.focusMode', false));
	private focusOverride = $state<number | null>(null);

	/** The OP focus mode shows: selected in the sidebar, else the OP of the focused row, else the first. */
	get focusOp(): number | null {
		const pick = this.focusOverride;
		if (pick !== null && this.allOps.some((o) => o.order === pick)) return pick;
		if (this.focusedOrder !== null) {
			const hit = this.findStep(this.focusedOrder);
			if (hit) return hit.op.order;
		}
		return this.allOps[0]?.order ?? null;
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
		write('opal.author.focusMode', on);
	}

	jumpTo(order: number) {
		const hit = this.findStep(order);
		if (!hit) return;
		if (this.focusMode) this.focusOp = hit.op.order;
		this.overrides[`op:${hit.op.order}`] = true;
		this.focusedOrder = order;
		this.pulse = order;
		setTimeout(() => {
			const el = document.getElementById(`step-${order}`);
			if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			else
				document
					.getElementById(`op-${hit.op.order}`)
					?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}, 30);
		setTimeout(() => (this.pulse = null), 1600);
	}

	// ---------- controller: data capture preview ----------

	private preview = $state<Record<number, Record<string, unknown>>>({});
	fieldValue(step: DocStep, name: string): unknown {
		return this.preview[step.order]?.[name];
	}
	setField(step: DocStep, name: string, value: unknown) {
		(this.preview[step.order] ??= {})[name] = value;
	}
	fieldErrors(): Record<string, string> {
		return {};
	}

	// ---------- keyboard ----------

	rows() {
		const rows: { op: DocOp; step: DocStep }[] = [];
		for (const op of this.allOps) {
			rows.push({ op, step: op.step });
			if (op.steps.length && this.isOpen(`op:${op.order}`))
				for (const s of op.steps) rows.push({ op, step: s });
		}
		return rows;
	}

	/**
	 * j/k and arrows move; Enter edits the title; e toggles the body; a adds a
	 * step after; o adds an OP after; d duplicates; x deletes; Alt+Up/Down
	 * moves; Escape leaves a field.
	 */
	handleKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		const typing =
			!!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
		if (typing) {
			if (e.key === 'Escape') {
				(t as HTMLElement).blur();
				e.preventDefault();
			}
			return;
		}
		if (e.metaKey || e.ctrlKey) {
			if (e.key === 's') {
				e.preventDefault();
				void this.flushAll();
			}
			return;
		}
		if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
		const rows = this.rows();
		if (!rows.length) {
			if (e.key === 'o' || e.key === 'a') {
				e.preventDefault();
				void this.addOp();
			}
			return;
		}
		const idx = rows.findIndex((r) => r.step.order === this.focusedOrder);
		const cur = idx >= 0 ? rows[idx] : undefined;
		const go = (to: number) => {
			e.preventDefault();
			const r = rows[Math.min(rows.length - 1, Math.max(0, to))];
			this.focusedOrder = r.step.order;
			(
				document.getElementById(`step-${r.step.order}`) ??
				document.getElementById(`op-${r.op.order}`)
			)?.scrollIntoView({ block: 'nearest' });
		};
		if (e.altKey && cur && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			e.preventDefault();
			void this.move(cur.step, e.key === 'ArrowUp' ? -1 : 1);
			return;
		}
		if (e.altKey) return;
		if (e.key === 'j' || e.key === 'ArrowDown') return go(idx < 0 ? 0 : idx + 1);
		if (e.key === 'k' || e.key === 'ArrowUp') return go(idx < 0 ? rows.length - 1 : idx - 1);
		if (!cur) return;
		const isOp = cur.step === cur.op.step;
		if (e.key === 'Enter') {
			e.preventDefault();
			const key = isOp ? `op:${cur.op.order}` : `step:${cur.step.order}`;
			if (!this.isOpen(key)) this.toggle(key, false);
			this.focusTitle(cur.step.order);
		} else if (e.key === 'e') {
			e.preventDefault();
			this.toggle(isOp ? `op:${cur.op.order}` : `step:${cur.step.order}`, false);
		} else if (e.key === 'a') {
			e.preventDefault();
			void this.addStep(cur.op, cur.step);
		} else if (e.key === 'o') {
			e.preventDefault();
			void this.addOp({ after: cur.op });
		} else if (e.key === 'd') {
			e.preventDefault();
			void this.duplicate(cur.step);
		} else if (e.key === 'x') {
			e.preventDefault();
			void this.remove(cur.step);
		} else if (e.key === 'J') {
			e.preventDefault();
			void this.move(cur.step, 1);
		} else if (e.key === 'K') {
			e.preventDefault();
			void this.move(cur.step, -1);
		}
	}

	// ---------- controller wiring ----------

	actions: DocActions = {};

	get author(): AuthorActions {
		return this;
	}
}
