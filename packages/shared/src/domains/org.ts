/** Contracts for the org area: users, roles, gates, workcenters, projects, organization settings, onboarding. */
import { z } from 'zod';
import { op, zEmpty, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zTimestamp } from '../time.ts';
import { zTimeDisplay } from './auth.ts';

/** A boolean that arrives as 'true' or 'false' in a query string. */
const zQueryBool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

// ---------------------------------------------------------------- shared shapes

export const zWorkcenterRef = z.object({ id: z.number().int(), name: z.string() });
export const zRoleRef = z.object({ id: z.number().int(), name: z.string() });
/** A person wherever one appears. `avatarUrl` is null when the client draws initials. */
export const zPersonRef = z.object({
	id: z.number().int(),
	name: z.string(),
	avatarUrl: z.string().nullable()
});
export type PersonRef = z.infer<typeof zPersonRef>;

const zProfileFields = {
	jobTitle: z.string().nullable(),
	phone: z.string().nullable(),
	workcenter: zWorkcenterRef.nullable(),
	roles: z.array(zRoleRef),
	avatarUrl: z.string().nullable()
};

// ---------------------------------------------------------------- users

export const zOrgUser = z.object({
	id: z.number().int(),
	name: z.string(),
	username: z.string(),
	email: z.string().nullable(),
	isActive: z.boolean(),
	isAdmin: z.boolean(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp,
	/** Sign-in facts an admin needs to decide how to hand an account over. */
	hasPassword: z.boolean(),
	hasPasskey: z.boolean(),
	ssoLinked: z.boolean(),
	...zProfileFields
});
export type OrgUser = z.infer<typeof zOrgUser>;

export const zDirectoryEntry = z.object({
	id: z.number().int(),
	name: z.string(),
	username: z.string(),
	...zProfileFields
});
export type DirectoryEntry = z.infer<typeof zDirectoryEntry>;

/** Syntax-only email check. Reserved names such as `.local` are valid on a LAN. */
export const zEmail = z
	.string()
	.trim()
	.max(255)
	.regex(/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/, 'Not a valid email address');

export const zUserCreate = z.object({
	name: z.string().trim().min(1).max(255),
	username: z.string().trim().max(64).nullable().optional(),
	/** No password: the account starts unclaimed and its owner claims it. */
	password: z.string().min(1).max(256).nullable().optional(),
	email: zEmail.nullable().optional(),
	isAdmin: z.boolean().default(false)
});

export const zUserUpdate = z.object({
	name: z.string().trim().min(1).max(255).optional(),
	email: zEmail.nullable().optional(),
	isActive: z.boolean().optional(),
	isAdmin: z.boolean().optional(),
	jobTitle: z.string().max(120).nullable().optional(),
	phone: z.string().max(40).nullable().optional(),
	workcenterId: z.number().int().nullable().optional()
});

export const zActivityEntry = z.object({
	timestamp: zTimestamp,
	table: z.string(),
	action: z.string(),
	subject: z.string().nullable()
});

export type UserActivityEntry = z.infer<typeof zActivityEntry>;

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export const zProfileState = z.object({
	needsProfileSetup: z.boolean(),
	needsOnboarding: z.boolean()
});

const users = {
	list: op({
		name: 'users.list',
		method: 'GET',
		path: '/users',
		summary: 'List users by name. Filter by text (name, username, email) and active state.',
		input: zPageInput.extend({
			search: z.string().optional(),
			isActive: zQueryBool.optional()
		}),
		output: zPage(zOrgUser).extend({ total: z.number().int() }),
		access: 'admin',
		mcp: true
	}),
	directory: op({
		name: 'users.directory',
		method: 'GET',
		path: '/users/directory',
		summary: 'Active users by name, for assignee and owner pickers. Carries no email.',
		input: zEmpty,
		output: z.array(zDirectoryEntry),
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'users.create',
		method: 'POST',
		path: '/users',
		summary: 'Create a user. Without a password the account starts unclaimed.',
		input: zUserCreate,
		output: zOrgUser,
		access: 'admin',
		mcp: false
	}),
	get: op({
		name: 'users.get',
		method: 'GET',
		path: '/users/:id',
		summary: 'Get one user. Admins read anyone; others only themselves.',
		input: z.object({ id: zId }),
		output: zOrgUser,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'users.update',
		method: 'PATCH',
		path: '/users/:id',
		summary:
			'Update a user. Others edit only their own name, email, job title, phone and workcenter. ' +
			'The last active admin cannot lose admin or be deactivated.',
		input: zUserUpdate.extend({ id: zId }),
		output: zOrgUser,
		access: 'signed-in',
		mcp: true
	}),
	deactivate: op({
		name: 'users.deactivate',
		method: 'DELETE',
		path: '/users/:id',
		summary: 'Deactivate an account and end its sessions. The last active admin cannot be deactivated.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: false
	}),
	resetPassword: op({
		name: 'users.resetPassword',
		method: 'POST',
		path: '/users/:id/reset-password',
		summary: 'Clear a password and end the sessions of the user. The owner then claims the account.',
		input: z.object({ id: zId }),
		output: z.object({ ok: z.literal(true), sessionsRevoked: z.number().int() }),
		access: 'admin',
		humanOnly: true,
		mcp: false
	}),
	activity: op({
		name: 'users.activity',
		method: 'GET',
		path: '/users/:id/activity',
		summary: 'The most recent audited changes of a user, newest first.',
		input: z.object({ id: zId, limit: z.coerce.number().int().min(1).max(100).default(15) }),
		output: z.array(zActivityEntry),
		access: 'signed-in',
		mcp: true
	}),
	setRoles: op({
		name: 'users.setRoles',
		method: 'PUT',
		path: '/users/:id/roles',
		summary:
			'Replace the roles of a user with exactly roleIds. The Admin role sets or clears isAdmin. ' +
			'The last active admin cannot lose admin.',
		input: z.object({ id: zId, roleIds: z.array(zId) }),
		output: zOrgUser,
		access: 'admin',
		mcp: false
	}),
	uploadAvatar: op({
		name: 'users.uploadAvatar',
		method: 'POST',
		path: '/users/:id/avatar',
		summary: 'Set the photo of a user: PNG, JPEG, WebP or GIF, at most 2 MB, as base64. Self or admin.',
		input: z.object({ id: zId, data: z.string().min(1) }),
		output: zOrgUser,
		access: 'signed-in',
		mcp: false
	}),
	removeAvatar: op({
		name: 'users.removeAvatar',
		method: 'DELETE',
		path: '/users/:id/avatar',
		summary: 'Remove the photo of a user. Initials show instead. Self or admin.',
		input: z.object({ id: zId }),
		output: zOrgUser,
		access: 'signed-in',
		mcp: false
	}),
	profileState: op({
		name: 'users.profileState',
		method: 'GET',
		path: '/users/me/profile-state',
		summary: 'Whether the signed-in user still owes a display name or the orientation.',
		input: zEmpty,
		output: zProfileState,
		access: 'signed-in',
		mcp: false
	}),
	setTimeDisplay: op({
		name: 'users.setTimeDisplay',
		method: 'PUT',
		path: '/users/me/time-display',
		summary: 'Choose whether the signed-in user sees times in the browser zone or in UTC.',
		input: z.object({ timeDisplay: zTimeDisplay }),
		output: z.object({ timeDisplay: zTimeDisplay }),
		access: 'signed-in',
		mcp: false
	}),
	setupProfile: op({
		name: 'users.setupProfile',
		method: 'POST',
		path: '/users/me/setup-profile',
		summary: 'Set the display name of the signed-in user and clear the profile-setup flag.',
		input: z.object({ name: z.string().trim().min(1).max(255) }),
		output: zOrgUser,
		access: 'signed-in',
		mcp: false
	})
};

// ---------------------------------------------------------------- roles and gates

export const zRole = z.object({
	id: z.number().int(),
	name: z.string(),
	description: z.string().nullable(),
	key: z.string().nullable(),
	isSystem: z.boolean(),
	memberCount: z.number().int(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Role = z.infer<typeof zRole>;

export const zRoleDetail = zRole.extend({ members: z.array(zPersonRef) });

export const zGate = z.object({
	key: z.string(),
	label: z.string(),
	description: z.string(),
	roleIds: z.array(z.number().int())
});
export type GateInfo = z.infer<typeof zGate>;

const roles = {
	list: op({
		name: 'roles.list',
		method: 'GET',
		path: '/roles',
		summary: 'Roles, system roles first, each with its count of active members.',
		input: zEmpty,
		output: z.array(zRole),
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'roles.get',
		method: 'GET',
		path: '/roles/:id',
		summary: 'One role with its active members.',
		input: z.object({ id: zId }),
		output: zRoleDetail,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'roles.create',
		method: 'POST',
		path: '/roles',
		summary: 'Create a role. Names are unique ignoring case.',
		input: z.object({
			name: z.string().trim().min(1).max(50),
			description: z.string().max(1000).nullable().optional()
		}),
		output: zRole,
		access: 'admin',
		mcp: false
	}),
	update: op({
		name: 'roles.update',
		method: 'PATCH',
		path: '/roles/:id',
		summary: 'Rename or describe a role. A system role cannot be renamed.',
		input: z.object({
			id: zId,
			name: z.string().trim().min(1).max(50).optional(),
			description: z.string().max(1000).nullable().optional()
		}),
		output: zRole,
		access: 'admin',
		mcp: false
	}),
	delete: op({
		name: 'roles.delete',
		method: 'DELETE',
		path: '/roles/:id',
		summary: 'Delete a custom role with its grants. A system role cannot be deleted.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'admin',
		mcp: false
	})
};

const gates = {
	list: op({
		name: 'gates.list',
		method: 'GET',
		path: '/gates',
		summary: 'Every gate with the ids of the roles that pass it. Admin always passes.',
		input: zEmpty,
		output: z.array(zGate),
		access: 'signed-in',
		mcp: true
	}),
	set: op({
		name: 'gates.set',
		method: 'PUT',
		path: '/gates/:key',
		summary: 'Replace the roles that pass a gate with exactly roleIds.',
		input: z.object({ key: z.string(), roleIds: z.array(zId) }),
		output: zGate,
		access: 'admin',
		mcp: false
	})
};

// ---------------------------------------------------------------- workcenters

export const zWorkcenter = z.object({
	id: z.number().int(),
	name: z.string(),
	code: z.string(),
	description: z.string().nullable(),
	location: z.string().nullable(),
	isActive: z.boolean(),
	defaultStepCount: z.number().int(),
	queuedStepCount: z.number().int()
});
export type Workcenter = z.infer<typeof zWorkcenter>;

export const zWorkcenterWork = z.object({
	defaultSteps: z.array(
		z.object({
			procedureId: z.number().int(),
			procedureName: z.string(),
			procedureStatus: z.string(),
			stepNumber: z.string(),
			title: z.string()
		})
	),
	queue: z.array(
		z.object({
			instanceId: z.number().int(),
			workOrderNumber: z.string().nullable(),
			procedureId: z.number().int(),
			procedureName: z.string(),
			instanceStatus: z.string(),
			priority: z.number().int(),
			targetCompletionAt: zTimestamp.nullable(),
			stepNumberStr: z.string(),
			stepTitle: z.string().nullable(),
			stepStatus: z.string()
		})
	)
});
export type WorkcenterWork = z.infer<typeof zWorkcenterWork>;

const zWorkcenterFields = {
	name: z.string().trim().min(1).max(255),
	code: z.string().trim().min(1).max(50),
	description: z.string().nullable().optional(),
	location: z.string().max(255).nullable().optional(),
	isActive: z.boolean()
};

const workcenters = {
	list: op({
		name: 'workcenters.list',
		method: 'GET',
		path: '/workcenters',
		summary: 'Workcenters by code, with step counts. Active ones unless activeOnly is false.',
		input: z.object({
			activeOnly: zQueryBool.optional(),
			search: z.string().optional()
		}),
		output: z.array(zWorkcenter),
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'workcenters.get',
		method: 'GET',
		path: '/workcenters/:id',
		summary: 'One workcenter.',
		input: z.object({ id: zId }),
		output: zWorkcenter,
		access: 'signed-in',
		mcp: true
	}),
	work: op({
		name: 'workcenters.work',
		method: 'GET',
		path: '/workcenters/:id/work',
		summary: 'Procedure steps that default to a workcenter and the open work queued at it.',
		input: z.object({ id: zId }),
		output: zWorkcenterWork,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'workcenters.create',
		method: 'POST',
		path: '/workcenters',
		summary: 'Create a workcenter. The code is stored upper case and is unique.',
		input: z.object({ ...zWorkcenterFields, isActive: z.boolean().default(true) }),
		output: zWorkcenter,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'workcenters.update',
		method: 'PATCH',
		path: '/workcenters/:id',
		summary: 'Update a workcenter.',
		input: z.object({
			id: zId,
			name: zWorkcenterFields.name.optional(),
			code: zWorkcenterFields.code.optional(),
			description: zWorkcenterFields.description,
			location: zWorkcenterFields.location,
			isActive: zWorkcenterFields.isActive.optional()
		}),
		output: zWorkcenter,
		access: 'signed-in',
		mcp: true
	}),
	deactivate: op({
		name: 'workcenters.deactivate',
		method: 'DELETE',
		path: '/workcenters/:id',
		summary: 'Deactivate a workcenter. Steps that name it keep it.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: false
	})
};

// ---------------------------------------------------------------- project

export const zTier = z.object({
	level: z.number().int(),
	name: z.string().trim().min(1, 'must not be blank'),
	code: z
		.string()
		.trim()
		.min(1, 'must not be blank')
		.refine((c) => !/\s/.test(c), 'must not contain spaces'),
	description: z.string().default(''),
	defaultTracking: z.enum(['serialized', 'bulk']),
	requireLot: z.boolean(),
	autoSerial: z.boolean()
});
export type Tier = z.infer<typeof zTier>;

/** A tier on input. Omitted semantics keep the stored value of that level, else the level rule. */
export const zTierInput = zTier.extend({
	defaultTracking: z.enum(['serialized', 'bulk']).nullable().optional(),
	requireLot: z.boolean().nullable().optional(),
	autoSerial: z.boolean().nullable().optional()
});

/** Placeholders a part number format may use. */
export const PART_NUMBER_VARIABLES = [
	'prefix',
	'sep',
	'tier_code',
	'tier_name',
	'tier_level',
	'sequence'
] as const;

export const zPartNumbering = z.object({
	prefix: z.string().default(''),
	separator: z.string().default('-'),
	sequenceDigits: z.number().int().min(1).max(10).default(4),
	format: z
		.string()
		.default('{prefix}{sep}{tier_code}{sep}{sequence}')
		.superRefine((value, ctx) => {
			const allowed = PART_NUMBER_VARIABLES.map((v) => `{${v}}`).join(', ');
			const unknown = [...value.matchAll(/\{(\w*)\}/g)]
				.map((m) => m[1]!)
				.filter((v) => !(PART_NUMBER_VARIABLES as readonly string[]).includes(v));
			if (unknown.length || /\{[^}]*$|^[^{]*\}/.test(value.replace(/\{\w+\}/g, ''))) {
				ctx.addIssue({ code: 'custom', message: `unusable format; the variables are ${allowed}` });
			} else if (!value.includes('{sequence}')) {
				ctx.addIssue({
					code: 'custom',
					message: 'the format must contain {sequence}, or part numbers repeat'
				});
			}
		})
});
export type PartNumbering = z.infer<typeof zPartNumbering>;

export const zRequirementCatalogEntry = z.object({
	id: z.string(),
	title: z.string(),
	description: z.string().default(''),
	category: z.string().default('')
});

export const zOrgSettings = z.object({
	name: z.string(),
	description: z.string(),
	tiers: z.array(zTier),
	partNumbering: zPartNumbering,
	categories: z.array(z.string()),
	requirements: z.array(zRequirementCatalogEntry),
	customFields: z.record(z.string(), z.unknown())
});
export type OrgSettings = z.infer<typeof zOrgSettings>;

export const zOrgSettingsInput = z
	.object({
		name: z.string().trim().min(1, 'must not be blank'),
		description: z.string().default(''),
		tiers: z.array(zTierInput).min(1, 'at least one tier is required'),
		partNumbering: zPartNumbering,
		categories: z.array(z.string()).default([]),
		/** Omitted keeps the stored custom fields. */
		customFields: z.record(z.string(), z.unknown()).nullable().optional()
	})
	.superRefine((v, ctx) => {
		if (new Set(v.tiers.map((t) => t.level)).size !== v.tiers.length) {
			ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'tier levels must be unique' });
		}
		if (new Set(v.tiers.map((t) => t.code)).size !== v.tiers.length) {
			ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'tier codes must be unique' });
		}
	});

// ---------------------------------------------------------------- projects

export const PROJECT_STATES = ['active', 'archived'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/** A project wherever a scoped record shows it. */
export const zProjectRef = z.object({ id: z.number().int(), code: z.string(), name: z.string() });
export type ProjectRef = z.infer<typeof zProjectRef>;

export const zProject = z.object({
	id: z.number().int(),
	code: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	state: z.enum(PROJECT_STATES),
	archivedAt: zTimestamp.nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Project = z.infer<typeof zProject>;

const zProjectCode = z
	.string()
	.trim()
	.min(1, 'must not be blank')
	.max(24)
	.refine((c) => !/\s/.test(c), 'must not contain spaces');

const projects = {
	list: op({
		name: 'projects.list',
		method: 'GET',
		path: '/projects',
		summary: 'List projects by code. `state` narrows to active or archived projects.',
		input: zPageInput.extend({ state: z.enum(PROJECT_STATES).optional(), search: z.string().optional() }),
		output: zPage(zProject),
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'projects.get',
		method: 'GET',
		path: '/projects/:id',
		summary: 'One project.',
		input: z.object({ id: zId }),
		output: zProject,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'projects.create',
		method: 'POST',
		path: '/projects',
		summary: 'Create a project. The code is unique, stored in upper case.',
		input: z.object({
			code: zProjectCode,
			name: z.string().trim().min(1, 'must not be blank'),
			description: z.string().nullable().optional()
		}),
		output: zProject,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'projects.update',
		method: 'PATCH',
		path: '/projects/:id',
		summary: 'Change the code, name or description of an active project.',
		input: z.object({
			id: zId,
			code: zProjectCode.optional(),
			name: z.string().trim().min(1, 'must not be blank').optional(),
			description: z.string().nullable().optional()
		}),
		output: zProject,
		access: 'signed-in',
		mcp: true
	}),
	archive: op({
		name: 'projects.archive',
		method: 'POST',
		path: '/projects/:id/archive',
		summary: 'Archive a project. Terminal: it takes no new records and cannot be reopened.',
		input: z.object({ id: zId }),
		output: zProject,
		access: 'signed-in',
		mcp: true
	})
};

// ---------------------------------------------------------------- organization settings

export const zSystemInfo = z.object({
	opalVersion: z.string(),
	runtime: z.string(),
	platform: z.string(),
	server: z.string(),
	dataDir: z.string(),
	dbPath: z.string(),
	dbSizeBytes: z.number().int().nullable()
});

export type SystemInfo = z.infer<typeof zSystemInfo>;

export const zAgentActivation = z.object({
	enabled: z.boolean(),
	/** Display name of the admin who authorized agent activation. */
	authorizedBy: z.string().nullable()
});

export type AgentActivation = z.infer<typeof zAgentActivation>;

const settings = {
	get: op({
		name: 'settings.get',
		method: 'GET',
		path: '/settings/organization',
		summary: 'The organization settings: tiers, part numbering scheme, categories. 404 before setup.',
		input: zEmpty,
		output: zOrgSettings,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'settings.create',
		method: 'POST',
		path: '/settings/organization',
		summary: 'Set up the organization of this instance. Once only; later changes use settings.update.',
		input: zOrgSettingsInput,
		output: zOrgSettings,
		access: 'admin',
		mcp: false
	}),
	update: op({
		name: 'settings.update',
		method: 'PUT',
		path: '/settings/organization',
		summary: 'Update the organization settings. A tier that parts still use cannot be removed.',
		input: zOrgSettingsInput,
		output: zOrgSettings,
		access: 'admin',
		mcp: false
	}),
	previewPartNumber: op({
		name: 'settings.previewPartNumber',
		method: 'POST',
		path: '/settings/preview-part-number',
		summary: 'Show the part number the scheme gives for a tier and a sequence.',
		input: z.object({ tierLevel: z.number().int(), sequence: z.number().int().min(0).default(1) }),
		output: z.object({ partNumber: z.string(), tierName: z.string() }),
		access: 'signed-in',
		mcp: false
	}),
	nextPartNumber: op({
		name: 'settings.nextPartNumber',
		method: 'GET',
		path: '/settings/next-part-number',
		summary: 'The next part number of a tier. Does not use it up.',
		input: z.object({ tier: z.coerce.number().int() }),
		output: z.object({ partNumber: z.string(), sequence: z.number().int() }),
		access: 'signed-in',
		mcp: true
	}),
	system: op({
		name: 'settings.system',
		method: 'GET',
		path: '/settings/system',
		summary: 'Version, platform and storage facts of this instance.',
		input: zEmpty,
		output: zSystemInfo,
		access: 'signed-in',
		mcp: false
	}),
	agentActivation: op({
		name: 'settings.agentActivation',
		method: 'GET',
		path: '/settings/agent-activation',
		summary: 'Whether the MCP agent may activate parts, and which admin allowed it.',
		input: zEmpty,
		output: zAgentActivation,
		access: 'signed-in',
		mcp: false
	}),
	setAgentActivation: op({
		name: 'settings.setAgentActivation',
		method: 'PUT',
		path: '/settings/agent-activation',
		summary: 'Allow or forbid the MCP agent to activate parts. Allowing records the acting admin.',
		input: z.object({ enabled: z.boolean() }),
		output: zAgentActivation,
		access: 'admin',
		humanOnly: true,
		mcp: false
	})
};

// ---------------------------------------------------------------- welcome

const welcome = {
	state: op({
		name: 'welcome.state',
		method: 'GET',
		path: '/welcome',
		summary: 'Which onboarding applies: organization setup for the first admin on an empty catalog, else the tutorial.',
		input: zEmpty,
		output: z.object({ mode: z.enum(['setup', 'tutorial']) }),
		access: 'signed-in',
		mcp: false
	}),
	complete: op({
		name: 'welcome.complete',
		method: 'POST',
		path: '/welcome/complete',
		summary: 'Mark the onboarding of the signed-in user as done.',
		input: zEmpty,
		output: zOk,
		access: 'signed-in',
		mcp: false
	})
};

export const org = { users, roles, gates, workcenters, projects, settings, welcome };
