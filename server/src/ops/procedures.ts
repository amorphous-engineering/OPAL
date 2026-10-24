import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import '../services/procedures/hooks.ts';
import * as procedures from '../services/procedures/index.ts';
import * as images from '../services/procedures/images.ts';
import * as kit from '../services/procedures/kit.ts';
import * as steps from '../services/procedures/steps.ts';
import * as versions from '../services/procedures/versions.ts';

const p = contracts.procedures;
const ok = { ok: true as const };

export const proceduresImpls = [
	// Static paths before `/procedures/:id`.
	implement(p.build, (ctx, i) => procedures.build(ctx, i)),
	implement(p.versions.get, (ctx, i) => versions.getVersion(ctx, i.versionId)),
	implement(p.versions.qr, (ctx, i) => versions.versionQr(ctx, i.versionId, i.url)),
	implement(p.list, (ctx, i) => procedures.list(ctx, i)),
	implement(p.create, (ctx, i) => procedures.create(ctx, i)),
	implement(p.get, (ctx, i) => procedures.get(ctx, i.id)),
	implement(p.update, (ctx, i) => procedures.updateProcedure(ctx, i)),
	implement(p.delete, (ctx, i) => {
		procedures.deleteProcedure(ctx, i.id);
		return ok;
	}),
	implement(p.clone, (ctx, i) => procedures.clone(ctx, i)),
	implement(p.draft, (ctx, i) => procedures.draft(ctx, i.id)),
	implement(p.dependencies, (ctx, i) => steps.listDependencies(ctx, i.id)),

	implement(p.steps.add, (ctx, i) => steps.addStep(ctx, i)),
	implement(p.steps.reorder, (ctx, i) => steps.reorderSteps(ctx, i.id, i.stepIds)),
	implement(p.steps.update, (ctx, i) => steps.updateStep(ctx, i)),
	implement(p.steps.remove, (ctx, i) => {
		steps.deleteStep(ctx, i.id, i.stepId);
		return ok;
	}),
	implement(p.steps.duplicate, (ctx, i) => steps.duplicateStep(ctx, i.id, i.stepId)),
	implement(p.steps.move, (ctx, i) => steps.moveStep(ctx, i)),
	implement(p.steps.setDependencies, (ctx, i) => steps.setDependencies(ctx, i.id, i.stepId, i.dependsOn)),

	implement(p.steps.images.list, (ctx, i) => images.listImages(ctx, i.id, i.stepId)),
	implement(p.steps.images.reorder, (ctx, i) => images.reorderImages(ctx, i.id, i.stepId, i.imageIds)),
	implement(p.steps.images.update, (ctx, i) => images.updateImage(ctx, i.id, i.stepId, i.imageId, i)),
	implement(p.steps.images.remove, (ctx, i) => {
		images.removeImage(ctx, i.id, i.stepId, i.imageId);
		return ok;
	}),

	implement(p.steps.kit.list, (ctx, i) => kit.listKit(ctx, { procedureId: i.id, stepId: i.stepId })),
	implement(p.steps.kit.add, (ctx, i) => kit.addKit(ctx, { procedureId: i.id, stepId: i.stepId }, i)),
	implement(p.steps.kit.update, (ctx, i) => kit.updateKit(ctx, { procedureId: i.id, stepId: i.stepId }, i.kitId, i)),
	implement(p.steps.kit.remove, (ctx, i) => {
		kit.removeKit(ctx, { procedureId: i.id, stepId: i.stepId }, i.kitId);
		return ok;
	}),

	implement(p.kit.list, (ctx, i) => kit.listKit(ctx, { procedureId: i.id })),
	implement(p.kit.add, (ctx, i) => kit.addKit(ctx, { procedureId: i.id }, i)),
	implement(p.kit.update, (ctx, i) => kit.updateKit(ctx, { procedureId: i.id }, i.kitId, i)),
	implement(p.kit.remove, (ctx, i) => {
		kit.removeKit(ctx, { procedureId: i.id }, i.kitId);
		return ok;
	}),

	implement(p.outputs.list, (ctx, i) => kit.listOutputs(ctx, i.id)),
	implement(p.outputs.add, (ctx, i) => kit.addOutput(ctx, i.id, i.partId, i.quantity)),
	implement(p.outputs.update, (ctx, i) => kit.updateOutput(ctx, i.id, i.outputId, i.quantity)),
	implement(p.outputs.remove, (ctx, i) => {
		kit.removeOutput(ctx, i.id, i.outputId);
		return ok;
	}),

	implement(p.versions.list, (ctx, i) => versions.listVersions(ctx, i.id)),
	implement(p.versions.publish, (ctx, i) => versions.publish(ctx, i.id, i.changeNote)),
	implement(p.versions.diff, (ctx, i) => versions.diffVersions(ctx, i.id, i.versionA, i.versionB)),
	implement(p.versions.restore, (ctx, i) => versions.restoreVersion(ctx, i.id, i.versionId))
] as Impl[];
