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
import type { DocMode, DocOp, DocStep } from './types.js';

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
	complete?(step: DocStep): Promise<void>;
	signoff?(step: DocStep): Promise<void>;
	/** Open the skip dialog. */
	skip?(step: DocStep): void;
	/** Open the raise-issue dialog at this step. */
	raiseIssue?(step: DocStep): void;
	/** Open the redline dialog on an OP that carries an open NC. */
	redline?(op: DocOp): void;
	/** Delete a not-yet-started redline OP. */
	deleteRedline?(op: DocOp): Promise<void>;
	attach?(step: DocStep): void;
	/** Bring a step's evidence into view (the host keeps evidence outside the document). */
	showEvidence?(step: DocStep): void;
	addNote?(step: DocStep, body: string): Promise<boolean>;
	consume?(step: DocStep, items: ConsumeItem[]): Promise<boolean>;
	loadStock?(partId: number): Promise<StockRecord[]>;
	/** Upload photos for a photo capture field; resolves to the new attachment ids. */
	uploadPhotos?(step: DocStep, files: File[]): Promise<number[]>;
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
	/** Is the OP card (key `op:3`) or step body (`step:5`) expanded? */
	isOpen(key: string, terminal: boolean): boolean;
	toggle(key: string, terminal: boolean): void;
	setFocus(order: number): void;
	/** Data capture: viewer's unsaved value for a field (falls back to the stored one). */
	fieldValue(step: DocStep, name: string): unknown;
	setField(step: DocStep, name: string, value: unknown): void;
	fieldErrors(step: DocStep): Record<string, string>;
	actions: DocActions;
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
