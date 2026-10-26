/**
 * The document controller: everything a procedure document needs from its host.
 *
 * The components in this folder are presentational. They receive plain data
 * (`DocOp`, `DocStep`) as props and reach the host through one controller,
 * provided with `provideDoc()` by whoever renders the document (the execution
 * page today, the template editor later). A control whose action is absent from
 * `actions` is not rendered, so `readonly` is simply "no actions" and `author`
 * will be a different set of actions on the same components.
 */
import { getContext, setContext } from 'svelte';
import type { Callout, DocLabor, DocMode, DocOp, DocSchema, DocStep, SignoffDef } from './types.js';

export interface StockRecord {
	id: number;
	part_id: number;
	part_name: string;
	part_uom: string | null;
	quantity: number | string;
	location: string;
	lot_number: string | null;
	opal_number: string | null;
}

export interface ConsumeItem {
	inventory_record_id: number;
	quantity: number;
	usage_type: string;
}

/** Operator actions. Optional: an absent action removes its control. */
export interface DocActions {
	/** Mark this step as where the viewer is working (one claim per user). */
	claim?(step: DocStep): Promise<void>;
	release?(): Promise<void>;
	/** Sign one sign-off slot. Slot 0 carries the captured data and the old COMPLETE gate. */
	sign?(step: DocStep, slot: number): Promise<void>;
	/** Open the skip dialog. */
	skip?(step: DocStep): void;
	/** Open the raise-issue dialog at this step. */
	raiseIssue?(step: DocStep): void;
	/** Open the redline dialog on an OP that carries an open NC. */
	redline?(op: DocOp): void;
	/** Delete a not-yet-started redline OP. */
	deleteRedline?(op: DocOp): Promise<void>;
	/** Bring a step's evidence into view (the host keeps evidence outside the document). */
	showEvidence?(step: DocStep): void;
	/** Add a markdown execution note with files attached to it. */
	addNote?(step: DocStep, body: string, files?: File[]): Promise<boolean>;
	consume?(step: DocStep, items: ConsumeItem[]): Promise<boolean>;
	loadStock?(partId: number): Promise<StockRecord[]>;
	/** Upload photos for a photo capture field; resolves to the new attachment ids. */
	uploadPhotos?(step: DocStep, files: File[]): Promise<number[]>;
}

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** The authored properties of a step, by the names the document uses. */
export interface StepEdit {
	title?: string;
	instructions?: string | null;
	callouts?: Callout[];
	role?: string | null;
	requires_signoff?: boolean;
	signoffs?: SignoffDef[] | null;
	estimated_duration_minutes?: number | null;
	is_contingency?: boolean;
	strict_sequence?: boolean;
	workcenter_id?: number | null;
	data_schema?: DocSchema | null;
}

export interface PartHit {
	id: number;
	internal_pn: string | null;
	name: string;
	unit_of_measure: string;
	lifecycle_state: string;
}

export interface WorkcenterOption {
	id: number;
	code: string;
	name: string;
}

/** Template authoring: present when `mode === 'author'`. Edits apply locally at once and autosave. */
export interface AuthorActions {
	/** Edit properties of an OP or step. Text is debounced; the rest saves at once. */
	edit(step: DocStep, patch: StepEdit): void;
	/** Autosave state of one step (worst of its pending edits). */
	stepState(step: DocStep): SaveState;
	/** Message of the last failed save of this step, if any. */
	stepError(step: DocStep): string | null;
	retry(): Promise<void>;
	addOp(opts?: { after?: DocOp; contingency?: boolean }): Promise<void>;
	/** Add a sub-step right after `after` (or first in the OP when `after` is the OP's own step). */
	addStep(op: DocOp, after: DocStep): Promise<void>;
	remove(step: DocStep): Promise<void>;
	duplicate(step: DocStep): Promise<void>;
	move(step: DocStep, direction: -1 | 1): Promise<void>;
	/** Place a step at `index` among the sub-steps of `parent` (null: among the OPs). */
	moveTo(step: DocStep, parent: DocOp | null, index: number): Promise<void>;
	setDependencies(op: DocOp, onIds: number[]): Promise<void>;
	/** Every top-level OP, for "waits on" choices. */
	ops(): DocOp[];
	workcenters: WorkcenterOption[];
	addImages(step: DocStep, files: File[]): Promise<void>;
	setCaption(step: DocStep, imageId: number, caption: string): void;
	removeImage(step: DocStep, imageId: number): Promise<void>;
	moveImage(step: DocStep, imageId: number, direction: -1 | 1): Promise<void>;
	addKit(
		step: DocStep,
		part: PartHit,
		quantity: number,
		usage: string,
		notes: string | null
	): Promise<void>;
	editKit(
		step: DocStep,
		kitId: number,
		patch: { quantity_required?: number; usage_type?: string; notes?: string | null }
	): void;
	removeKit(step: DocStep, kitId: number): Promise<void>;
	/** Upload an image for use inside markdown; resolves to the markdown to insert. */
	uploadInline(file: File): Promise<string>;
	/** Drag and drop: what is being dragged and where it would land. */
	drag: { id: number | null; over: { id: number; pos: 'before' | 'after' | 'into' } | null };
	dropOn(target: { id: number; pos: 'before' | 'after' | 'into' }): Promise<void>;
}

export interface DocController {
	mode: DocMode;
	/** The signed-in viewer, for self-highlighting. */
	viewerId: number | null;
	/** The document accepts work (a work order that is cut or in work). */
	active: boolean;
	/** Keyboard cursor; local, broadcasts nothing. */
	focusedOrder: number | null;
	/** The viewer's claimed step (presence), or null. */
	claimedOrder: number | null;
	/** Time worked on an OP, per person. Absent where no work is clocked (authoring). */
	laborFor?(opOrder: number): DocLabor[];
	/** Is the OP card (key `op:3`) or step body (`step:5`) expanded? Defaults: open
	 *  unless finished — or `blocked` (nothing to act on yet). */
	isOpen(key: string, terminal: boolean, blocked?: boolean): boolean;
	toggle(key: string, terminal: boolean, blocked?: boolean): void;
	/** The one step the page points at: the next thing to do. Gets the accent. */
	currentOrder?: number | null;
	setFocus(order: number): void;
	/** Data capture: viewer's unsaved value for a field (falls back to the stored one). */
	fieldValue(step: DocStep, name: string): unknown;
	setField(step: DocStep, name: string, value: unknown): void;
	fieldErrors(step: DocStep): Record<string, string>;
	actions: DocActions;
	/** Template authoring; only in author mode. */
	author?: AuthorActions;
}

const KEY = Symbol('procedure-doc');

export function provideDoc(controller: DocController): DocController {
	setContext(KEY, controller);
	return controller;
}

export function useDoc(): DocController {
	const ctl = getContext<DocController | undefined>(KEY);
	if (!ctl) throw new Error('procedure-doc components need provideDoc() in an ancestor');
	return ctl;
}
