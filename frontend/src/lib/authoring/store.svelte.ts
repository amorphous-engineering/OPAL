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
import { api } from '#lib/api.js';
import { confirm, toastError } from '#lib/components/opal/index.js';
import type {
	AuthorActions,
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
import type { DraftResponse, DraftStep } from './types.js';

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
const OP_MIRROR = ['title', 'instructions', 'caution', 'is_contingency'] as const;

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
			this.workcenters = await api.get<WorkcenterOption[]>('/workcenters');
		} catch {
			/* optional picker: the editor works without it */
		}
	}

	// ---------- loading ----------

	private async fetchDraft(): Promise<DraftStep[]> {
		return (await api.get<DraftResponse>(this.url('/draft'))).steps;
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
		const numberOf = new Map(draft.map((d) => [d.id, d.step_number]));
		const kidsOf = new Map<number, number>();
		for (const d of draft)
			if (d.parent_step_id !== null)
				kidsOf.set(d.parent_step_id, (kidsOf.get(d.parent_step_id) ?? 0) + 1);
		this.leafIds = new Set(
			draft.filter((d) => d.parent_step_id === null && !kidsOf.has(d.id)).map((d) => d.id)
		);
		this.smallDoc = draft.length <= SMALL_DOC;

		for (const d of draft) {
			let st = this.byId.get(d.id);
			if (!st) {
				const fresh: DocStep = $state(this.blank(d));
				st = fresh;
				this.byId.set(d.id, st);
			}
			st.number = d.step_number;
			st.level = d.level;
			st.is_op = d.parent_step_id === null;
			st.parent_order = d.parent_step_id;
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
			set('caution', 'caution', d.caution);
			if (!dirty(d.id, 'signoffs')) {
				set('role', 'role', d.required_role);
				set('requires_signoff', 'requires_signoff', d.requires_signoff);
				const defs = (d.signoffs ?? []).map((x) => ({ label: x.label, role: x.role ?? null }));
				if (JSON.stringify(st.signoff_defs ?? []) !== JSON.stringify(defs)) {
					st.signoff_defs = defs;
					st.signoffs = previewSlots(defs);
					st.signoffs = previewSlots(defs);
				}
			}
			set('estimated_duration_minutes', 'estimated_duration_minutes', d.estimated_duration_minutes);
			set('is_contingency', 'is_contingency', d.is_contingency);
			set('workcenter_id', 'workcenter_id', d.workcenter_id);
			if (
				!dirty(d.id, 'data_schema') &&
				JSON.stringify(st.data_schema) !== JSON.stringify(d.required_data_schema)
			)
				st.data_schema = d.required_data_schema;
			const images = d.images.map((i) => ({
				id: i.id,
				attachment_id: i.attachment_id,
				caption: i.caption
			}));
			if (JSON.stringify(st.images) !== JSON.stringify(images)) st.images = images;
			const kit = d.step_kit.map((k) => ({
				id: k.id,
				part_id: k.part_id,
				part_name: k.part_name,
				part_number: k.part_internal_pn,
				quantity_required: k.quantity_required,
				usage_type: k.usage_type,
				notes: k.notes
			}));
			if (JSON.stringify(st.step_kit) !== JSON.stringify(kit)) st.step_kit = kit;
		}

		const build = (group: DraftStep[]): DocOp[] =>
			group.map((d) => {
				const st = this.byId.get(d.id)!;
				const subs = draft
					.filter((x) => x.parent_step_id === d.id)
					.map((x) => this.byId.get(x.id)!);
				let op = this.opById.get(d.id);
				if (!op) {
					const fresh: DocOp = $state(this.blankOp(st));
					op = fresh;
					this.opById.set(d.id, op);
				}
				op.number = d.step_number;
				op.title = st.title;
				op.instructions = st.instructions;
				op.caution = st.caution;
				op.role = st.role;
				op.is_contingency = st.is_contingency;
				if (
					!(this.pending.get(d.id) && 'strict_sequence' in this.pending.get(d.id)!) &&
					!(this.inflight.get(d.id) && 'strict_sequence' in this.inflight.get(d.id)!)
				)
					op.strict_sequence = d.strict_sequence;
				op.depends_on = d.depends_on;
				op.waiting_on_ops = d.depends_on.map((x) => numberOf.get(x) ?? '?');
				op.progress = { done: 0, total: subs.length };
				op.step = st;
				const same = op.steps.length === subs.length && op.steps.every((s, i) => s === subs[i]);
				if (!same) op.steps = subs;
				return op;
			});
		const tops = draft.filter((d) => d.parent_step_id === null);
		const ops = build(tops.filter((d) => !d.is_contingency));
		const contingency = build(tops.filter((d) => d.is_contingency));
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
			number: d.step_number,
			title: d.title,
			level: d.level,
			is_op: d.parent_step_id === null,
			parent_order: d.parent_step_id,
			status: 'pending',
			instructions: d.instructions,
			caution: d.caution,
			role: d.required_role,
			requires_signoff: d.requires_signoff,
			is_contingency: d.is_contingency,
			estimated_duration_minutes: d.estimated_duration_minutes,
			workcenter_id: d.workcenter_id,
			images: [],
			step_kit: [],
			data_schema: d.required_data_schema,
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
			caution: step.caution,
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

	private apiBody(patch: StepEdit): Record<string, unknown> {
		const body: Record<string, unknown> = {};
		if ('title' in patch) body.title = patch.title;
		if ('instructions' in patch) body.instructions = norm(patch.instructions);
		if ('caution' in patch) body.caution = norm(patch.caution);
		if ('role' in patch) body.required_role = norm(patch.role);
		if ('requires_signoff' in patch) body.requires_signoff = patch.requires_signoff;
		if ('signoffs' in patch)
			body.signoffs = patch.signoffs
				? patch.signoffs.map((x) => ({ label: x.label.trim(), role: norm(x.role) }))
				: null;
		if ('estimated_duration_minutes' in patch)
			body.estimated_duration_minutes = patch.estimated_duration_minutes ?? null;
		if ('is_contingency' in patch) body.is_contingency = patch.is_contingency;
		if ('strict_sequence' in patch) body.strict_sequence = patch.strict_sequence;
		if ('workcenter_id' in patch) body.workcenter_id = patch.workcenter_id ?? null;
		if ('data_schema' in patch) {
			const fields = patch.data_schema?.fields ?? [];
			body.required_data_schema = fields.length ? patch.data_schema : null;
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
		const textual = keys.some((k) =>
			[
				'title',
				'instructions',
				'caution',
				'role',
				'signoffs',
				'estimated_duration_minutes'
			].includes(k)
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
			const r = await api.patch<{ step_number: string }>(
				this.url(`/steps/${id}`),
				this.apiBody(patch)
			);
			this.inflight.delete(id);
			const st = this.byId.get(id);
			if (st && r.step_number) st.number = r.step_number;
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
			api.post<{ id: number }>(this.url('/steps'), {
				title: 'New operation',
				after_step_id: opts.after?.order,
				is_contingency: opts.after ? opts.after.is_contingency : !!opts.contingency
			})
		);
		if (made) this.focusTitle(made.id);
	};

	addStep = async (op: DocOp, after: DocStep) => {
		const made = await this.structure(() =>
			api.post<{ id: number }>(this.url('/steps'), {
				title: 'New step',
				parent_step_id: op.order,
				after_step_id: after.order
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
			await api.del(this.url(`/steps/${step.order}`));
			return true;
		});
		if (done) this.focusedOrder = neighbour;
	};

	duplicate = async (step: DocStep) => {
		const made = await this.structure(() =>
			api.post<{ id: number }>(this.url(`/steps/${step.order}/duplicate`))
		);
		if (made) this.focusTitle(made.id);
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
			api.post(this.url(`/steps/${step.order}/move`), {
				parent_step_id: parent ? parent.order : null,
				index,
				...(parent === null ? { is_contingency: step.is_contingency } : {})
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
				api.post(this.url(`/steps/${srcId}/move`), {
					parent_step_id: null,
					index: at,
					is_contingency: targetOp.is_contingency
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
			await api.put(this.url(`/steps/${op.order}/dependencies`), { depends_on: onIds });
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
				const r = await api.post<{ id: number; attachment_id: number; caption: string | null }>(
					this.url(`/steps/${step.order}/images`),
					fd
				);
				step.images = [
					...step.images,
					{ id: r.id, attachment_id: r.attachment_id, caption: r.caption }
				];
			}
		});
	};

	setCaption = (step: DocStep, imageId: number, caption: string) => {
		const img = step.images.find((i) => i.id === imageId);
		if (!img) return;
		img.caption = caption;
		this.schedule(`cap:${imageId}`, step.order, TEXT_DELAY, async () => {
			await api.patch(this.url(`/steps/${step.order}/images/${imageId}`), {
				caption: caption.trim() || null
			});
		});
	};

	removeImage = async (step: DocStep, imageId: number) => {
		await this.track(step.order, 'imgdel', async () => {
			await api.del(this.url(`/steps/${step.order}/images/${imageId}`));
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
				await api.post(this.url(`/steps/${step.order}/images/reorder`), {
					image_ids: list.map((x) => x.id)
				});
			} catch (e) {
				step.images = before;
				throw e;
			}
		});
	};

	// ---------- step parts ----------

	searchParts = async (q: string): Promise<PartHit[]> => {
		const r = await api.get<{ items: PartHit[] }>('/parts', { search: q, limit: 8 });
		return r.items;
	};

	addKit = async (
		step: DocStep,
		part: PartHit,
		quantity: number,
		usage: string,
		notes: string | null
	) => {
		await this.track(step.order, 'kit', async () => {
			const r = await api.post<{ id: number }>(this.url(`/steps/${step.order}/kit`), {
				part_id: part.id,
				quantity_required: quantity,
				usage_type: usage,
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
			await api.patch(this.url(`/steps/${step.order}/kit/${kitId}`), {
				quantity_required: line.quantity_required,
				usage_type: line.usage_type,
				notes: line.notes ?? ''
			});
		});
	};

	removeKit = async (step: DocStep, kitId: number) => {
		const line = step.step_kit.find((k) => k.id === kitId);
		if (!line) return;
		await this.track(step.order, 'kitdel', async () => {
			await api.del(this.url(`/steps/${step.order}/kit/${line.part_id}`));
			step.step_kit = step.step_kit.filter((k) => k.id !== kitId);
		});
	};

	uploadInline = async (file: File): Promise<string> => {
		const fd = new FormData();
		fd.append('file', file);
		fd.append('procedure_id', String(this.procedureId));
		fd.append('kind', 'inline');
		const r = await api.post<{ id: number }>('/attachments/upload', fd);
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
		const fields = d.required_data_schema?.fields ?? [];
		return [
			d.id,
			d.step_number,
			d.parent_step_id,
			d.title,
			norm(d.instructions),
			norm(d.caution),
			(d.signoffs ?? []).map((x) => [x.label, norm(x.role)]),
			d.estimated_duration_minutes ?? null,
			d.is_contingency,
			d.strict_sequence,
			d.workcenter_id ?? null,
			fields.length ? JSON.stringify(d.required_data_schema) : null,
			[...d.depends_on].sort(),
			d.images.map((i) => [i.id, norm(i.caption)]),
			d.step_kit.map((k) => [k.id, k.quantity_required, k.usage_type, norm(k.notes)])
		];
	}

	private fingerprint(draft: DraftStep[]): string {
		return JSON.stringify(draft.map((d) => this.canon(d)));
	}

	/** What this editor holds, projected to the server's shape and order. */
	private localFingerprint(server: DraftStep[]): string {
		const local: DraftStep[] = [];
		for (const s of server) {
			const st = this.byId.get(s.id);
			if (!st) {
				local.push({ ...s, id: -1 });
				continue;
			}
			const op = this.opById.get(s.id);
			local.push({
				id: st.order,
				order: s.order,
				step_number: st.number,
				level: st.level,
				parent_step_id: st.parent_order,
				title: st.title,
				instructions: st.instructions,
				required_data_schema: st.data_schema,
				is_contingency: st.is_contingency,
				requires_signoff: st.requires_signoff,
				signoffs: (st.signoff_defs ?? []).map((x) => ({ label: x.label, role: x.role })),
				estimated_duration_minutes: st.estimated_duration_minutes ?? null,
				required_role: st.role,
				caution: st.caution,
				strict_sequence: op ? op.strict_sequence : s.strict_sequence,
				workcenter_id: st.workcenter_id ?? null,
				depends_on: op?.depends_on ?? [],
				images: st.images.map((i) => ({
					id: i.id!,
					attachment_id: i.attachment_id,
					caption: i.caption,
					position: 0
				})),
				step_kit: st.step_kit.map((k) => ({
					id: k.id!,
					part_id: k.part_id,
					part_name: k.part_name,
					part_internal_pn: k.part_number,
					quantity_required: k.quantity_required,
					usage_type: k.usage_type,
					notes: k.notes
				}))
			});
		}
		// A step the server lacks (deleted elsewhere) or one we lack: lengths differ.
		if (this.byId.size !== server.length) return 'length-differs';
		return JSON.stringify(local.map((d) => this.canon(d)));
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

	jumpTo(order: number) {
		const hit = this.findStep(order);
		if (!hit) return;
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
