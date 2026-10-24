/**
 * Non-JSON routes of the procedures area: the step image upload (multipart).
 *
 *   POST /api/procedures/:id/steps/:stepId/images   multipart: file, caption?
 */
import { op, OpalError, unauthenticated, zId, zProcedureStepImage } from '@opal/shared';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import { type Impl, implement, type ResolveActor, runOp } from '../../registry.ts';
import { maxUploadBytes } from '../platform/attachments.ts';
import { addImage } from './images.ts';

const addImageContract = op({
	name: 'procedures.steps.images.add',
	method: 'POST',
	path: '/procedures/:id/steps/:stepId/images',
	summary: 'Upload a reference image to a step.',
	input: z.object({
		id: zId,
		stepId: zId,
		file: z.custom<File>((v) => v instanceof File, 'a file is required'),
		caption: z.string().max(255).nullish()
	}),
	output: zProcedureStepImage,
	access: 'signed-in',
	mcp: false
});

const addImageImpl: Impl = implement(addImageContract, async (ctx, i) =>
	addImage(
		ctx,
		i.id,
		i.stepId,
		{ name: i.file.name, type: i.file.type, bytes: new Uint8Array(await i.file.arrayBuffer()) },
		i.caption
	)
);

export function mountProcedureRoutes(app: Hono, db: Db, resolveActor: ResolveActor): void {
	app.post(
		'/api/procedures/:id/steps/:stepId/images',
		bodyLimit({
			maxSize: maxUploadBytes() + 1024 * 1024,
			onError: (c) => c.json({ error: 'file_too_large', message: 'File too large' }, 413)
		}),
		async (c: Context) => {
			const actor = await resolveActor(c);
			if (actor.kind === 'anonymous') throw unauthenticated();
			const form = await c.req.parseBody();
			const caption = typeof form.caption === 'string' && form.caption !== '' ? form.caption : undefined;
			if (!(form.file instanceof File)) throw new OpalError(422, 'invalid_input', 'Invalid input', { file: 'a file is required' });
			const out = await runOp(addImageImpl, db, actor, {
				id: c.req.param('id'),
				stepId: c.req.param('stepId'),
				file: form.file,
				caption
			});
			return c.json(out as object, 201);
		}
	);
}
