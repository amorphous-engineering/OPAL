/** Instance facts, the agent-activation switch, and onboarding state. */
import { statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { part, user } from '../../db/schema/index.ts';
import { dataDir, dbPath } from '../../paths.ts';
import { VERSION } from '../../version.ts';
import { upsertProfile } from './profiles.ts';
import { getSetting, setSetting } from './settings.ts';

export function systemInfo() {
	let size: number | null = null;
	try {
		size = statSync(dbPath()).size;
	} catch {
		/* in-memory or not yet written */
	}
	return {
		opalVersion: VERSION,
		runtime: `Bun ${Bun.version}`,
		platform: `${platform()} ${release()} (${arch()})`,
		server: `${process.env.OPAL_HOST ?? '0.0.0.0'}:${process.env.OPAL_PORT ?? 8080}`,
		dataDir: dataDir(),
		dbPath: dbPath(),
		dbSizeBytes: size
	};
}

export const AGENT_ACTIVATION_KEY = 'mcp_agent_activation_operator_id';

/** The admin who allowed the MCP agent to activate parts, or null when it may not. */
export function agentActivation(ctx: Pick<Ctx, 'db'>) {
	const raw = getSetting(ctx.db, AGENT_ACTIVATION_KEY);
	const operator = raw && /^\d+$/.test(raw) ? ctx.db.select().from(user).where(eq(user.id, Number(raw))).get() : undefined;
	return { enabled: operator !== undefined, authorizedBy: operator?.name ?? null };
}

export function setAgentActivation(ctx: Ctx, enabled: boolean) {
	const id = ctx.actor.kind === 'user' || ctx.actor.kind === 'token' ? ctx.actor.userId : null;
	setSetting(ctx, AGENT_ACTIVATION_KEY, enabled && id !== null ? String(id) : null);
	return agentActivation(ctx);
}

/** The first admin on an empty catalog sets the project up; everyone else gets the orientation. */
export function welcomeMode(ctx: Ctx): 'setup' | 'tutorial' {
	const admin = (ctx.actor.kind === 'user' || ctx.actor.kind === 'token') && ctx.actor.isAdmin;
	const fresh = ctx.db.select({ id: part.id }).from(part).limit(1).get() === undefined;
	return admin && fresh ? 'setup' : 'tutorial';
}

export function completeOnboarding(ctx: Ctx): void {
	if (ctx.actor.kind !== 'user' && ctx.actor.kind !== 'token') return;
	upsertProfile(ctx, ctx.actor.userId, { needsOnboarding: false });
}
