import { contracts } from '@opal/shared';
import { project as projectTable, role as roleTable, user as userTable, workcenter as workcenterTable } from '../db/schema/index.ts';
import { type Impl, implement } from '../registry.ts';
import { registerEntity, registerReversible, registerSearchable, revertRows } from '../services/platform/index.ts';
import * as numbering from '../services/org/numbering.ts';
import * as project from '../services/org/project.ts';
import * as projects from '../services/org/projects.ts';
import * as roles from '../services/org/roles.ts';
import * as system from '../services/org/system.ts';
import * as users from '../services/org/users.ts';
import * as workcenters from '../services/org/workcenters.ts';
import { forbidden, notFound, OpalError } from '@opal/shared';

const c = contracts.org;

registerEntity(projectTable, {
	label: 'Project',
	ref: (r) => ({ label: `${r.code} ${r.name}`, href: `/projects/${r.id}` })
});
registerEntity(workcenterTable, {
	label: 'Workcenter',
	ref: (r) => ({ label: `${r.code} ${r.name}`, href: `/workcenters/${r.id}` })
});
registerSearchable({
	type: 'workcenter',
	table: workcenterTable,
	columns: [workcenterTable.name, workcenterTable.code, workcenterTable.description],
	identifier: workcenterTable.code,
	hit: (r) => ({ label: r.name, sublabel: r.code, href: `/workcenters/${r.id}`, status: r.isActive ? 'active' : 'inactive' })
});
registerEntity(roleTable, {
	label: 'Role',
	ref: (r) => ({ label: r.name, href: `/settings?role=${r.id}#roles` })
});
// Undo: single-table edits revert from their audit rows. Role deletion and role assignment
// touch the user_role links too, so they stay out.
for (const op of ['workcenters.create', 'workcenters.update', 'workcenters.deactivate'])
	registerReversible(op, { revert: (ctx, rows) => revertRows(ctx, rows, { workcenter: workcenterTable }) });
for (const op of ['roles.create', 'roles.update'])
	registerReversible(op, { revert: (ctx, rows) => revertRows(ctx, rows, { role: roleTable }) });
registerReversible('projects.update', { revert: (ctx, rows) => revertRows(ctx, rows, { project: projectTable }) });
registerReversible('users.update', {
	// Same rule as updateUser: a non-admin changes only their own profile fields.
	authorize: (ctx, rows) => {
		if (ctx.actor.kind !== 'user' && ctx.actor.kind !== 'token') return;
		if (ctx.actor.isAdmin) return;
		const own = new Set(['name', 'jobTitle', 'phone', 'workcenterId']);
		for (const r of rows) {
			if (r.entityId !== ctx.actor.userId) throw forbidden('Cannot edit other users');
			const b = (r.before ?? {}) as Record<string, unknown>;
			const a = (r.after ?? {}) as Record<string, unknown>;
			const bad = Object.keys({ ...b, ...a }).filter((k) => !['id', 'updatedAt'].includes(k) && b[k] !== a[k] && !own.has(k));
			if (bad.length) throw forbidden(`Cannot change fields: ${bad.join(', ')}`);
		}
	},
	revert: (ctx, rows) => revertRows(ctx, rows, { user: userTable })
});
registerSearchable({
	type: 'project',
	table: projectTable,
	columns: [projectTable.name, projectTable.description],
	identifier: projectTable.code,
	hit: (r) => ({ label: r.name, sublabel: r.code, href: `/projects/${r.id}`, status: r.state })
});

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
	implement(c.users.setTimeDisplay, (ctx, input) => users.setTimeDisplay(ctx, input.timeDisplay)),
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
	// projects
	implement(c.projects.list, (ctx, input) => projects.listProjects(ctx, input)),
	implement(c.projects.get, (ctx, input) => projects.getProject(ctx, input.id)),
	implement(c.projects.create, (ctx, input) => projects.createProject(ctx, input)),
	implement(c.projects.update, (ctx, input) => projects.updateProject(ctx, input)),
	implement(c.projects.archive, (ctx, input) => projects.archiveProject(ctx, input.id)),
	// organization settings
	implement(c.settings.get, (ctx) => {
		const config = project.getOrgSettings(ctx.db);
		if (!config) throw notFound('Organization settings');
		return config;
	}),
	implement(c.settings.create, (ctx, input) => project.createOrgSettings(ctx, input)),
	implement(c.settings.update, (ctx, input) => project.updateOrgSettings(ctx, input)),
	implement(c.settings.previewPartNumber, (ctx, input) => {
		const config = project.getOrgSettings(ctx.db);
		if (!config) throw notFound('Organization settings');
		const tier = project.getTier(config, input.tierLevel);
		if (!tier) throw new OpalError(400, 'unknown_tier', `Unknown tier level: ${input.tierLevel}`);
		return { partNumber: project.renderPartNumber(config, tier, input.sequence), tierName: tier.name };
	}),
	implement(c.settings.nextPartNumber, (ctx, input) => numbering.peekNextPartNumber(ctx.db, input.tier)),
	implement(c.settings.system, () => system.systemInfo()),
	implement(c.settings.agentActivation, (ctx) => system.agentActivation(ctx)),
	implement(c.settings.setAgentActivation, (ctx, input) => system.setAgentActivation(ctx, input.enabled)),
	// welcome
	implement(c.welcome.state, (ctx) => ({ mode: system.welcomeMode(ctx) })),
	implement(c.welcome.complete, (ctx) => (system.completeOnboarding(ctx), { ok: true as const }))
] as Impl[];
