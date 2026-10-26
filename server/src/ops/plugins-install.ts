import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as installer from '../services/plugins/install.ts';
import { getPlugin, toDetail } from '../services/plugins/store.ts';

const c = contracts.plugins;

export const pluginsInstallImpls: Impl[] = [
	implement(c.preview, (ctx, i) => installer.preview(ctx.db, i.source)),
	implement(c.install, async (ctx, i) => {
		const row = await installer.install(ctx, i.source, i.sha);
		return toDetail(ctx.db, getPlugin(ctx.db, row.key));
	}),
	implement(c.remove, async (ctx, i) => {
		await installer.remove(ctx, i.id);
		return { ok: true as const };
	})
];
