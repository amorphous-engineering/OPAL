import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import '../services/execution/hooks.ts';
import * as comments from '../services/execution/comments.ts';
import { buildDocument, buildState } from '../services/execution/document.ts';
import * as executions from '../services/execution/executions.ts';
import * as material from '../services/execution/material.ts';
import { raiseNc } from '../services/execution/nc.ts';
import * as presence from '../services/execution/presence.ts';
import * as redlines from '../services/execution/redlines.ts';
import { buildReport, holdsPayload, qrSvg } from '../services/execution/report.ts';
import * as steps from '../services/execution/steps.ts';

const e = contracts.execution;

export const executionImpls: Impl[] = [
	// Static paths before `/executions/:id`.
	implement(e.preview, (ctx, i) => executions.previewCut(ctx, i)),
	implement(e.list, (ctx, i) => executions.listExecutions(ctx, i)),
	implement(e.create, (ctx, i) => executions.createExecutions(ctx, i)),
	implement(e.get, (ctx, i) => executions.getExecution(ctx, i.id)),
	implement(e.update, (ctx, i) => executions.updateExecution(ctx, i)),
	implement(e.cancel, (ctx, i) => executions.cancelExecution(ctx, i)),
	implement(e.document, (ctx, i) => buildDocument(ctx, i.id)),
	implement(e.state, (ctx, i) => buildState(ctx, i.id)),
	implement(e.holds, (ctx, i) => holdsPayload(ctx, i.id)),
	implement(e.report, (ctx, i) => buildReport(ctx, i.id)),
	implement(e.qr, (ctx, i) => qrSvg(ctx, i.id, i.origin)),

	implement(e.focus, (ctx, i) => presence.focus(ctx, i)),
	implement(e.release, (ctx, i) => presence.release(ctx, i.id)),
	implement(e.join, (ctx, i) => presence.join(ctx, i.id)),
	implement(e.leave, (ctx, i) => presence.leave(ctx, i.id)),
	implement(e.participants, (ctx, i) => presence.participants(ctx, i.id)),

	implement(e.complete, (ctx, i) =>
		steps.signStep(ctx, { id: i.id, stepId: i.stepId, slot: 0, dataCaptured: i.dataCaptured, notes: i.notes })
	),
	implement(e.sign, (ctx, i) => steps.signStep(ctx, { id: i.id, stepId: i.stepId, slot: i.slot, dataCaptured: i.dataCaptured })),
	implement(e.signoff, (ctx, i) => steps.signNext(ctx, i)),
	implement(e.skip, (ctx, i) => steps.skipStep(ctx, i)),
	implement(e.addNote, (ctx, i) => steps.addNote(ctx, i)),
	implement(e.listComments, (ctx, i) => comments.listComments(ctx, i.id)),
	implement(e.addComment, (ctx, i) => comments.addComment(ctx, i.id, i.body)),
	implement(e.raiseNc, (ctx, i) => raiseNc(ctx, i)),

	implement(e.consumptions, (ctx, i) => material.listConsumptions(ctx, i.id)),
	implement(e.stepConsumptions, (ctx, i) => material.listConsumptions(ctx, i.id, i.stepId)),
	implement(e.kit, (ctx, i) => material.kitAvailability(ctx, i.id)),
	implement(e.consume, (ctx, i) => material.consume(ctx, i)),
	implement(e.consumeAtStep, (ctx, i) => material.consume(ctx, i)),
	implement(e.outputs, (ctx, i) => material.outputsOf(ctx, i.id)),
	implement(e.produce, (ctx, i) => material.produce(ctx, i)),
	implement(e.productions, (ctx, i) => material.listProductions(ctx, i.id)),
	implement(e.bom, (ctx, i) => material.bom(ctx, i.id)),
	implement(e.finalize, (ctx, i) => material.finalize(ctx, i)),

	implement(e.createRedline, (ctx, i) => redlines.createRedline(ctx, i)),
	implement(e.listRedlines, (ctx, i) => redlines.listRedlines(ctx, i.id)),
	implement(e.deleteRedline, (ctx, i) => redlines.deleteRedline(ctx, i))
];

