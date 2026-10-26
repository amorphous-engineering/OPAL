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
export { default as StepKit } from './StepKit.svelte';
export { default as ExecutionNotes } from './ExecutionNotes.svelte';
export { default as SignoffTable } from './SignoffTable.svelte';
export { default as StepImages } from './StepImages.svelte';
export { default as StepState } from './StepState.svelte';
export { default as CaptureFields } from './CaptureFields.svelte';
export { default as CaptureReadout } from './CaptureReadout.svelte';
export { default as CalloutBlock } from './CalloutBlock.svelte';
export { default as CalloutList } from './CalloutList.svelte';
export { calloutsOf } from './callouts.js';
export { default as CursorChips } from './CursorChips.svelte';
export { default as GateReason } from './GateReason.svelte';
export { attachmentUrl, gallery } from './viewer.js';
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
export { byPerson, clock, liveSeconds } from './labor.svelte.js';
