/**
 * Procedure document components. A procedure rendered as OP cards of step rows,
 * shared by the execution page (mode 'execute' / 'readonly') and, later, the
 * template editor (mode 'author').
 *
 * Usage:
 *   <ProcedureDocument {controller} ops={doc.ops} contingency={doc.contingency_ops} />
 *
 * `controller` (see ./controller.ts) carries mode, view state (expansion, focus,
 * claim, data-capture drafts) and the action set. Data is plain props (types.ts).
 */
export { default as ProcedureDocument } from './ProcedureDocument.svelte';
export { default as OpCard } from './OpCard.svelte';
export { default as StepRow } from './StepRow.svelte';
export { default as StepBody } from './StepBody.svelte';
export { default as StepActions } from './StepActions.svelte';
export { default as StepKit } from './StepKit.svelte';
export { default as StepNotes } from './StepNotes.svelte';
export { default as StepImages } from './StepImages.svelte';
export { default as StepState } from './StepState.svelte';
export { default as CaptureFields } from './CaptureFields.svelte';
export { default as CaptureReadout } from './CaptureReadout.svelte';
export { default as CautionBlock } from './CautionBlock.svelte';
export { default as RoleChip } from './RoleChip.svelte';
export { default as CursorChips } from './CursorChips.svelte';
export { default as GateReason } from './GateReason.svelte';
export { default as Lightbox } from './Lightbox.svelte';
export { lightbox, attachmentUrl } from './lightbox.svelte.js';
export { provideDoc, useDoc } from './controller.js';
export type {
	AuthorActions,
	ConsumeItem,
	DocActions,
	DocController,
	PartHit,
	SaveState,
	StepEdit,
	StockRecord,
	WorkcenterOption
} from './controller.js';
export { isActionable, isBlocked, isTerminal, visibleRows, TERMINAL_STATUSES } from './types.js';
export type * from './types.js';
