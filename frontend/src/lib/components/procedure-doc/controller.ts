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
import type { ExecUnit, InstalledComponent, RoleMark, UnitSlot } from '@opal/shared';
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
	/** A unit slot key: the part goes into the unit named there. */
	into?: string | null;
}

/** Naming the units a work order acts on, and taking components out of them. */
export interface UnitActions {
	bind(
		step: DocStep,
		body: {
			slot?: string | null;
			stockId?: number;
			borrowed?: { name: string; serial?: string | null; lentBy?: string | null };
		}
	): Promise<boolean>;
	unbind(unitId: number): Promise<boolean>;
	/** Serialized records of a part to name as a unit. */
	candidates(partId: number): Promise<StockRecordLite[]>;
	installed(unitId: number): Promise<InstalledComponent[]>;
	remove(
		step: DocStep,
		body: {
			unitId: number;
			stockId: number;
			quantity: string;
			location?: string | null;
			notes?: string | null;
		}
	): Promise<boolean>;
	/** The units named on the work order, for a removal at any step. */
	named(): ExecUnit[];
}

export interface StockRecordLite {
	id: number;
	opal_number: string;
	serial_number: string | null;
	location: string;
	balance: string;
}

/** Operator actions. Optional: an absent action removes its control. */
export interface DocActions {
	/** Mark this step as where the viewer is working (one claim per user). */
	claim?(step: DocStep): Promise<void>;
	release?(): Promise<void>;
	/** Sign one sign-off slot. Slot 0 carries the captured data and the old COMPLETE gate. */
	sign?(step: DocStep, slot: number): Promise<void>;
	/** Waive a later slot the signer of an earlier one cannot sign. Resolves to false when refused. */
	waive?(step: DocStep, slot: number, reason: string): Promise<boolean>;
	/** Skip a step. The reason is required. Resolves to false when the host refused it. */
	skip?(step: DocStep, reason: string): void | Promise<boolean>;
	/** The issue form for this step, carrying its run and step. + ISSUE opens it in a new tab. */
	issueHref?(step: DocStep): string;
	/** Open the redline dialog on an OP that carries an open NC. */
	redline?(op: DocOp): void;
	/** Delete a draft redline OP. */
	deleteRedline?(op: DocOp): Promise<void>;
	/** Open a draft redline OP for editing, in place. */
	editRedline?(op: DocOp): void;
	/** Release a draft written after its issue's disposition was signed. */
	releaseRedline?(op: DocOp): Promise<void>;
	/** Bring a step's evidence into view (the host keeps evidence outside the document). */
	showEvidence?(step: DocStep): void;
	/** Add a markdown execution note with files attached to it. */
	addNote?(step: DocStep, body: string, files?: File[]): Promise<boolean>;
	consume?(step: DocStep, items: ConsumeItem[]): Promise<boolean>;
	loadStock?(partId: number): Promise<StockRecord[]>;
	/** Upload photos for a photo capture field; resolves to the new attachment ids. */
	uploadPhotos?(step: DocStep, files: File[]): Promise<number[]>;
	units?: UnitActions;
}

/**
 * The viewer's note in progress on a step. It lives with the host, so closing the row or a document
 * refresh loses nothing. `save` resolves to false when the host refused it, and keeps the text.
 */
export interface NoteDraft {
	body(step: DocStep): string;
	setBody(step: DocStep, value: string): void;
	files(step: DocStep): File[];
	setFiles(step: DocStep, files: File[]): void;
	save(step: DocStep): Promise<boolean>;
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
	/** The role that does the step. Saved by name. */
	performer?: RoleMark | null;
	estimated_duration_minutes?: number | null;
	is_contingency?: boolean;
	strict_sequence?: boolean;
	workcenter_id?: number | null;
	data_schema?: DocSchema | null;
	/** OPs only: the unit slots. Null or empty clears them. */
	units?: UnitSlot[] | null;
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
	/** The procedure's project: its roles are offered beside the organization's. */
	projectId: number | null;
	addImages(step: DocStep, files: File[]): Promise<void>;
	setCaption(step: DocStep, imageId: number, caption: string): void;
	removeImage(step: DocStep, imageId: number): Promise<void>;
	moveImage(step: DocStep, imageId: number, direction: -1 | 1): Promise<void>;
	addKit(
		step: DocStep,
		part: PartHit,
		quantity: number,
		usage: string,
		notes: string | null,
		into?: string | null
	): Promise<void>;
	editKit(
		step: DocStep,
		kitId: number,
		patch: {
			quantity_required?: number;
			usage_type?: string;
			notes?: string | null;
			into?: string | null;
		}
	): void;
	/** Every unit slot the procedure declares, for kit lines that install into one. */
	unitSlots(): UnitSlot[];
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
	/** The work order was voided or closed short: its steps take no more notes. */
	struck?: boolean;
	/** Keyboard cursor; local, broadcasts nothing. */
	focusedOrder: number | null;
	/** The viewer's claimed step (presence), or null. */
	claimedOrder: number | null;
	/** Time worked on an OP, per person. Absent where no work is clocked (authoring). */
	laborFor?(opOrder: number): DocLabor[];
	/** Is the OP card (key `op:3`) or step body (`step:5`) expanded? The host decides the default. */
	isOpen(key: string, terminal: boolean, blocked?: boolean): boolean;
	toggle(key: string, terminal: boolean, blocked?: boolean): void;
	/** The one step the page points at: the next thing to do. Gets the accent. */
	currentOrder?: number | null;
	setFocus(order: number): void;
	/** Data capture: viewer's unsaved value for a field (falls back to the stored one). */
	fieldValue(step: DocStep, name: string): unknown;
	setField(step: DocStep, name: string, value: unknown): void;
	fieldErrors(step: DocStep): Record<string, string>;
	/** Present where steps take notes. */
	noteDraft?: NoteDraft;
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
