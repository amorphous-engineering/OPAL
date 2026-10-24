import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as numbering from '../services/org/numbering.ts';
import * as project from '../services/org/project.ts';
import * as roles from '../services/org/roles.ts';
import * as system from '../services/org/system.ts';
import * as users from '../services/org/users.ts';
import * as workcenters from '../services/org/workcenters.ts';
import { notFound, OpalError } from '@opal/shared';

const c = contracts.org;

export const orgImpls = [
	// users
	implement(c.users.list, (ctx, input) => users.listUsers(ctx, input)),
	implement(c.users.directory, (ctx) => users.directory(ctx)),
	implement(c.users.create, (ctx, input) => users.createUser(ctx, input)),
	implement(c.users.get, (ctx, input) => users.getUser(ctx, input.id)),
	implement(c.users.update, (ctx, input) => users.updateUser(ctx, input)),
	implement(c.users.deactivate, (ctx, input) => (users.deactivateUser(ctx, input.id), { ok: true as const })),
	implement(c.users.resetPassword, (ctx, input) => ({ ok: true as const, sessionsRevoked: users.resetPassword(ctx, input.id) })),
	implement(c.users.activity, (ctx, input) => users.activity(ctx, input.id, input.limit)),
	implement(c.users.setRoles, (ctx, input) => users.setUserRoles(ctx, input.id, input.roleIds)),
	implement(c.users.uploadAvatar, (ctx, input) => users.uploadAvatar(ctx, input.id, input.data)),
	implement(c.users.removeAvatar, (ctx, input) => users.deleteAvatar(ctx, input.id)),
	implement(c.users.profileState, (ctx) => users.myProfileState(ctx)),
	implement(c.users.setupProfile, (ctx, input) => users.setupProfile(ctx, input.name)),
	// roles and gates
	implement(c.roles.list, (ctx) => roles.listRoles(ctx)),
	implement(c.roles.get, (ctx, input) => roles.getRole(ctx, input.id)),
	implement(c.roles.create, (ctx, input) => roles.createRole(ctx, input)),
	implement(c.roles.update, (ctx, input) => roles.updateRole(ctx, input)),
	implement(c.roles.delete, (ctx, input) => (roles.deleteRole(ctx, input.id), { ok: true as const })),
	implement(c.gates.list, (ctx) => roles.listGates(ctx)),
	implement(c.gates.set, (ctx, input) => roles.setGate(ctx, input.key, input.roleIds)),
	// workcenters
	implement(c.workcenters.list, (ctx, input) => workcenters.listWorkcenters(ctx, input)),
	implement(c.workcenters.get, (ctx, input) => workcenters.getWorkcenter(ctx, input.id)),
	implement(c.workcenters.work, (ctx, input) => workcenters.workcenterWork(ctx, input.id)),
	implement(c.workcenters.create, (ctx, input) => workcenters.createWorkcenter(ctx, input)),
	implement(c.workcenters.update, (ctx, input) => workcenters.updateWorkcenter(ctx, input)),
	implement(c.workcenters.deactivate, (ctx, input) => (workcenters.deactivateWorkcenter(ctx, input.id), { ok: true as const })),
	// project
	implement(c.project.get, (ctx) => {
		const config = project.getProjectConfig(ctx.db);
		if (!config) throw notFound('Project configuration');
		return config;
	}),
	implement(c.project.create, (ctx, input) => project.createProject(ctx, input)),
	implement(c.project.update, (ctx, input) => project.updateProject(ctx, input)),
	implement(c.project.previewPartNumber, (ctx, input) => {
		const config = project.getProjectConfig(ctx.db);
		if (!config) throw notFound('Project configuration');
		const tier = project.getTier(config, input.tierLevel);
		if (!tier) throw new OpalError(400, 'unknown_tier', `Unknown tier level: ${input.tierLevel}`);
		return { partNumber: project.renderPartNumber(config, tier, input.sequence), tierName: tier.name };
	}),
	implement(c.project.nextPartNumber, (ctx, input) => numbering.peekNextPartNumber(ctx.db, input.tier)),
	// settings
	implement(c.settings.system, () => system.systemInfo()),
	implement(c.settings.agentActivation, (ctx) => system.agentActivation(ctx)),
	implement(c.settings.setAgentActivation, (ctx, input) => system.setAgentActivation(ctx, input.enabled)),
	// welcome
	implement(c.welcome.state, (ctx) => ({ mode: system.welcomeMode(ctx) })),
	implement(c.welcome.complete, (ctx) => (system.completeOnboarding(ctx), { ok: true as const }))
] as Impl[];
