/**
 * Contracts for the plugins area. A plugin is a GitHub repository with
 * `opal-plugin.json` and one built JavaScript file. OPAL runs it as a child
 * process with a scoped API token (notes/plugin-system.md).
 *
 * Plain Hono routes outside the contracts (server/src/services/plugins/proxy.ts):
 *   ALL /plugins/:key/*   signed-in users (or a panel token), proxied to the plugin
 *   ALL /hooks/:key/*     anyone, proxied when the manifest allows hooks
 */
import { z } from 'zod';
import { op, zOk } from '../op.ts';
import { zTimestamp } from '../time.ts';

// ------------------------------------------------------------------ manifest

/** The file at the root of a plugin repository. */
export const PLUGIN_MANIFEST_FILE = 'opal-plugin.json';

/** Fixed places in the app where a plugin panel can show. */
export const PANEL_SLOTS = ['issue.side', 'part.side', 'execution.side', 'project.side'] as const;
export type PanelSlot = (typeof PANEL_SLOTS)[number];

/** Record each slot gives the panel, as a query parameter of the same name. */
export const PANEL_SLOT_RECORD: Record<PanelSlot, string> = {
	'issue.side': 'issue',
	'part.side': 'part',
	'execution.side': 'execution',
	'project.side': 'project'
};

export const PLUGIN_SETTING_TYPES = ['text', 'url', 'secret', 'number', 'boolean', 'select', 'json'] as const;
export type PluginSettingType = (typeof PLUGIN_SETTING_TYPES)[number];

/** A relative path inside the plugin, without `..`. */
const zInnerPath = z
	.string()
	.min(1)
	.max(200)
	.refine((p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..'), 'Must be a relative path inside the plugin');

/** An operation name or a pattern that ends in `.*`: `issues.list`, `issues.*`. */
const zOpPattern = z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*(\.\*)?$|^\*$/, 'Operation name or pattern');
/** An event type or a pattern that ends in `*`: `execution_comment`, `issue_*`. */
const zEventPattern = z.string().regex(/^[a-z_]+\*?$|^\*$/, 'Event type or pattern');

export const zPluginSettingDef = z.strictObject({
	key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(64),
	label: z.string().min(1).max(80),
	type: z.enum(PLUGIN_SETTING_TYPES),
	required: z.boolean().optional(),
	/** For `select`. */
	options: z.array(z.string().min(1).max(80)).max(50).optional(),
	default: z.union([z.string(), z.number(), z.boolean()]).optional()
});
export type PluginSettingDef = z.infer<typeof zPluginSettingDef>;

export const zPluginPanelDef = z.strictObject({
	slot: z.enum(PANEL_SLOTS),
	title: z.string().min(1).max(40),
	/** Path the plugin serves, below /plugins/<id>. */
	path: z.string().regex(/^\/[^\s?#]*$/).max(200)
});
export type PluginPanelDef = z.infer<typeof zPluginPanelDef>;

export const zPluginManifest = z.strictObject({
	id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and hyphens').max(40),
	name: z.string().min(1).max(60),
	version: z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, 'Semver: 1.2.3'),
	/** Semver range of OPAL versions: `>=2.0.0`. */
	opal: z.string().min(1).max(60),
	main: zInnerPath,
	summary: z.string().max(200).optional(),
	homepage: z.url().optional(),
	permissions: z
		.strictObject({
			ops: z.array(zOpPattern).max(200).default([]),
			events: z.array(zEventPattern).max(50).default([]),
			hooks: z.boolean().default(false)
		})
		.default({ ops: [], events: [], hooks: false }),
	settings: z.array(zPluginSettingDef).max(50).default([]),
	panels: z.array(zPluginPanelDef).max(10).default([])
});
export type PluginManifest = z.infer<typeof zPluginManifest>;

/** True when `name` matches one of the patterns (`issues.*` matches `issues.comments.create`). */
export function matchesPattern(patterns: readonly string[], name: string): boolean {
	return patterns.some((p) => {
		if (p === '*') return true;
		if (p.endsWith('.*')) return name.startsWith(p.slice(0, -1));
		if (p.endsWith('*')) return name.startsWith(p.slice(0, -1));
		return p === name;
	});
}

// --------------------------------------------------------------------- views

export const PLUGIN_PROCESS_STATES = ['stopped', 'starting', 'running', 'crashed'] as const;

export const zPluginProcess = z.object({
	state: z.enum(PLUGIN_PROCESS_STATES),
	pid: z.number().int().nullable(),
	startedAt: zTimestamp.nullable(),
	restarts: z.number().int(),
	exitCode: z.number().int().nullable()
});

export const zPluginSummary = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string(),
	source: z.string(),
	ref: z.string().nullable(),
	sha: z.string(),
	/** The commit before the last update, kept on disk for a rollback. */
	previousSha: z.string().nullable(),
	enabled: z.boolean(),
	process: zPluginProcess,
	installedAt: zTimestamp,
	updatedAt: zTimestamp
});
export type PluginSummary = z.infer<typeof zPluginSummary>;

export const zPluginSettingValue = z.object({
	key: z.string(),
	/** Null for a secret: the API never returns a secret value. */
	value: z.unknown().nullable(),
	/** For a secret: a value is stored. */
	set: z.boolean()
});

export const zPluginDetail = zPluginSummary.extend({
	manifest: zPluginManifest,
	settings: z.array(zPluginSettingValue),
	/** The last lines the process wrote, oldest first. */
	log: z.array(z.string()),
	/** Username of the plugin's own user (audit rows name it). */
	username: z.string()
});
export type PluginDetail = z.infer<typeof zPluginDetail>;

export const zPluginPreview = z.object({
	source: z.string(),
	ref: z.string().nullable(),
	sha: z.string(),
	manifest: zPluginManifest,
	/** Set when a plugin with this id is installed: its version and permissions now. */
	installed: z
		.object({ version: z.string(), sha: z.string(), permissions: zPluginManifest.shape.permissions })
		.nullable(),
	/** False when the manifest's `opal` range excludes this server. */
	compatible: z.boolean()
});
export type PluginPreview = z.infer<typeof zPluginPreview>;

export const zPluginPanel = z.object({
	plugin: z.string(),
	title: z.string(),
	/** URL for the iframe, with a short-lived panel token. The page adds the record. */
	src: z.string()
});
export type PluginPanel = z.infer<typeof zPluginPanel>;

// ------------------------------------------------------------ external links

/** Records that can carry an external link. */
export const LINK_ENTITIES = ['issue', 'part', 'execution', 'project'] as const;
export type LinkEntity = (typeof LINK_ENTITIES)[number];

export const zExternalLink = z.object({
	id: z.number().int(),
	plugin: z.string(),
	pluginName: z.string(),
	entityType: z.enum(LINK_ENTITIES),
	entityId: z.number().int(),
	externalId: z.string(),
	url: z.url(),
	label: z.string().nullable(),
	updatedAt: zTimestamp
});
export type ExternalLink = z.infer<typeof zExternalLink>;

// ---------------------------------------------------------------- contracts

const zKey = z.object({ id: zPluginManifest.shape.id });
/** `owner/repo`, `owner/repo@ref`, or a github.com URL. */
const zSource = z.string().trim().min(3).max(300);

export const plugins = {
	list: op({
		name: 'plugins.list',
		method: 'GET',
		path: '/plugins',
		summary: 'List installed plugins and the state of their processes.',
		input: z.object({}),
		output: z.object({ items: z.array(zPluginSummary) }),
		access: 'admin',
		mcp: false
	}),
	get: op({
		name: 'plugins.get',
		method: 'GET',
		path: '/plugins/:id',
		summary: 'Get a plugin: manifest, settings (secrets masked), process state and log.',
		input: zKey,
		output: zPluginDetail,
		access: 'admin',
		mcp: false
	}),
	preview: op({
		name: 'plugins.preview',
		method: 'POST',
		path: '/plugins/preview',
		summary: 'Download a plugin from GitHub and show its manifest. Installs nothing.',
		input: z.object({ source: zSource }),
		output: zPluginPreview,
		access: 'admin',
		mcp: false
	}),
	install: op({
		name: 'plugins.install',
		method: 'POST',
		path: '/plugins/install',
		summary: 'Install or update a previewed plugin at the exact commit shown.',
		input: z.object({ source: zSource, sha: z.string().regex(/^([0-9a-f]{40}|local)$/) }),
		output: zPluginDetail,
		access: 'admin',
		humanOnly: true,
		mcp: false
	}),
	settings: op({
		name: 'plugins.settings',
		method: 'PUT',
		path: '/plugins/:id/settings',
		summary: 'Save plugin settings and restart the plugin. A secret left out keeps its value.',
		input: zKey.extend({ values: z.record(z.string(), z.unknown()) }),
		output: zPluginDetail,
		access: 'admin',
		humanOnly: true,
		mcp: false
	}),
	enable: op({
		name: 'plugins.enable',
		method: 'POST',
		path: '/plugins/:id/enable',
		summary: 'Start a plugin, now and on every server start.',
		input: zKey,
		output: zPluginDetail,
		access: 'admin',
		humanOnly: true,
		mcp: false
	}),
	disable: op({
		name: 'plugins.disable',
		method: 'POST',
		path: '/plugins/:id/disable',
		summary: 'Stop a plugin and revoke its token.',
		input: zKey,
		output: zPluginDetail,
		access: 'admin',
		mcp: false
	}),
	restart: op({
		name: 'plugins.restart',
		method: 'POST',
		path: '/plugins/:id/restart',
		summary: 'Restart the process of an enabled plugin.',
		input: zKey,
		output: zPluginDetail,
		access: 'admin',
		mcp: false
	}),
	remove: op({
		name: 'plugins.remove',
		method: 'DELETE',
		path: '/plugins/:id',
		summary: 'Stop a plugin, revoke its token, delete its files, settings and links. Its user stays, deactivated.',
		input: zKey,
		output: zOk,
		access: 'admin',
		humanOnly: true,
		mcp: false
	}),
	panels: op({
		name: 'plugins.panels',
		method: 'GET',
		path: '/plugin-panels',
		summary: 'Panels of the running plugins for one slot.',
		input: z.object({ slot: z.enum(PANEL_SLOTS) }),
		output: z.object({ items: z.array(zPluginPanel) }),
		access: 'signed-in',
		mcp: false
	}),
	links: {
		list: op({
			name: 'plugins.links.list',
			method: 'GET',
			path: '/links',
			summary: 'External links of one record, for example the Kaneo task of an issue.',
			input: z.object({ entityType: z.enum(LINK_ENTITIES), entityId: z.coerce.number().int().positive() }),
			output: z.object({ items: z.array(zExternalLink) }),
			access: 'signed-in',
			mcp: true
		}),
		set: op({
			name: 'plugins.links.set',
			method: 'PUT',
			path: '/links',
			summary: 'Create or update the calling plugin\'s link of a record to an external item.',
			input: z.object({
				entityType: z.enum(LINK_ENTITIES),
				entityId: z.coerce.number().int().positive(),
				externalId: z.string().min(1).max(200),
				url: z.url().max(1000),
				label: z.string().max(120).nullish()
			}),
			output: zExternalLink,
			access: 'signed-in',
			mcp: false
		}),
		remove: op({
			name: 'plugins.links.remove',
			method: 'DELETE',
			path: '/links',
			summary: 'Remove the calling plugin\'s link of a record to an external item.',
			input: z.object({
				entityType: z.enum(LINK_ENTITIES),
				entityId: z.coerce.number().int().positive(),
				externalId: z.string().min(1).max(200)
			}),
			output: zOk,
			access: 'signed-in',
			mcp: false
		})
	}
};
