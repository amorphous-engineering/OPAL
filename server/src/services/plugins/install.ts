/** Install, update and remove plugins: preview downloads, install moves files and writes rows. */
import { and, eq, isNull } from 'drizzle-orm';
import {
	conflict,
	OpalError,
	PLUGIN_MANIFEST_FILE,
	zPluginManifest,
	type PluginManifest,
	type PluginPreview
} from '@opal/shared';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PLUGIN_USERNAME_PREFIX } from '../../auth/tokens.ts';
import { actorUserId, type Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { hideAuditedValue, markOldBytes } from '../../db/seal-secrets.ts';
import { apiToken, externalLink, passkeyCredential, plugin, pluginSetting, user } from '../../db/schema/index.ts';
import { VERSION } from '../../version.ts';
import { insert, remove as removeRow, update } from '../../write.ts';
import { downloadTarball, parseSource, resolveSha, type ParsedSource } from './github.ts';
import { runtime } from './runtime.ts';
import { findPlugin, getPlugin, pluginDir, pluginsRoot, sealSetting, type PluginRow } from './store.ts';
import { extractTarGz } from './tar.ts';

const stagingRoot = () => join(pluginsRoot(), '.staging');
const STAGING_MAX_AGE_MS = 3_600_000;

/** A folder with its manifest checked: `main` exists and stays inside the folder. */
function readManifest(dir: string): PluginManifest {
	const file = join(dir, PLUGIN_MANIFEST_FILE);
	if (!existsSync(file)) {
		throw new OpalError(422, 'invalid_plugin', `The repository has no ${PLUGIN_MANIFEST_FILE} at its root`, {
			[PLUGIN_MANIFEST_FILE]: 'Missing'
		});
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		throw new OpalError(422, 'invalid_plugin', `${PLUGIN_MANIFEST_FILE} is not valid JSON`, {
			[PLUGIN_MANIFEST_FILE]: (e as Error).message
		});
	}
	const parsed = zPluginManifest.safeParse(raw);
	if (!parsed.success) {
		const fields: Record<string, string> = {};
		for (const i of parsed.error.issues) fields[i.path.join('.') || '_'] = i.message;
		throw new OpalError(422, 'invalid_plugin', `${PLUGIN_MANIFEST_FILE} is not valid`, fields);
	}
	const main = resolve(dir, parsed.data.main);
	if (!main.startsWith(resolve(dir) + sep) || !existsSync(main) || !statSync(main).isFile()) {
		throw new OpalError(422, 'invalid_plugin', `The main file ${parsed.data.main} is not in the repository`, {
			main: 'File not found'
		});
	}
	return parsed.data;
}

/** The server version without a pre-release tag: 2.0.0-rc.13 must meet `>=2.0.0` of its own release. */
export function isCompatible(range: string, version = VERSION): boolean {
	if (version === '0.0.0-dev') return true;
	try {
		return Bun.semver.satisfies(version.split(/[-+]/)[0]!, range);
	} catch {
		return false;
	}
}

/** Folders a crash left behind. Every normal path removes its own. */
function pruneStaging(): void {
	const root = stagingRoot();
	if (!existsSync(root)) return;
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (Date.now() - statSync(path).mtimeMs > STAGING_MAX_AGE_MS) rmSync(path, { recursive: true, force: true });
	}
}

/**
 * Download a commit into a staging folder of its own. The caller removes it. A preview keeps
 * nothing: install downloads the same commit again, and a commit's content cannot change between.
 */
async function stage(src: ParsedSource, sha: string): Promise<string> {
	pruneStaging();
	const data = await downloadTarball(src.owner!, src.repo!, sha);
	const dir = join(stagingRoot(), `${sha}-${crypto.randomUUID()}`);
	try {
		extractTarGz(data, dir);
	} catch (e) {
		unstage(dir);
		throw e;
	}
	return dir;
}

const unstage = (dir: string) => rmSync(dir, { recursive: true, force: true });

function localDir(src: ParsedSource): string {
	if (!existsSync(src.path!) || !statSync(src.path!).isDirectory()) {
		throw new OpalError(422, 'invalid_source', `Folder ${src.path} not found`, { source: 'Folder not found' });
	}
	return src.path!;
}

export async function preview(db: Db, input: string): Promise<PluginPreview> {
	const src = parseSource(input);
	if (src.kind === 'local') return describe(db, src, 'local', localDir(src));
	const sha = await resolveSha(src.owner!, src.repo!, src.ref);
	const dir = await stage(src, sha);
	try {
		return describe(db, src, sha, dir);
	} finally {
		unstage(dir);
	}
}

function describe(db: Db, src: ParsedSource, sha: string, dir: string): PluginPreview {
	const manifest = readManifest(dir);
	const row = findPlugin(db, manifest.id);
	return {
		source: src.source,
		ref: src.ref,
		sha,
		manifest,
		installed: row ? { version: row.version, sha: row.sha, permissions: row.manifest.permissions } : null,
		compatible: isCompatible(manifest.opal)
	};
}

function ensureUser(ctx: Ctx, manifest: PluginManifest): number {
	const username = `${PLUGIN_USERNAME_PREFIX}${manifest.id}`;
	const existing = ctx.db.select().from(user).where(eq(user.username, username)).get();
	if (existing) {
		// The name alone proves nothing: a person may hold it. Only a row without credentials is a plugin identity.
		const passkey = ctx.db.select({ id: passkeyCredential.id }).from(passkeyCredential).where(eq(passkeyCredential.userId, existing.id)).get();
		if (existing.passwordHash || existing.oidcIssuer || existing.oidcSubject || existing.email || existing.isAdmin || passkey) {
			throw conflict('plugin_user_taken', `User ${username} belongs to a person. Rename or remove that account before installing plugin ${manifest.id}.`);
		}
		if (!existing.isActive || existing.name !== manifest.name) {
			update(ctx, user, existing.id, { isActive: true, name: manifest.name });
		}
		return existing.id;
	}
	return insert(ctx, user, { username, name: manifest.name, isActive: true, isAdmin: false }).id;
}

/** The download happens here, outside the write queue. Everything after it is the write. */
export async function install(ctx: Ctx, input: string, sha: string): Promise<PluginRow> {
	const src = parseSource(input);
	if (src.kind === 'local') {
		if (sha !== 'local') throw new OpalError(422, 'invalid_input', 'A local plugin has the SHA local', { sha: 'Use local' });
		const dir = localDir(src);
		return ctx.write!(() => commitInstall(ctx, src, sha, dir));
	}
	if (sha === 'local') throw new OpalError(422, 'invalid_input', 'A GitHub plugin needs a commit SHA', { sha: 'Use a commit' });
	const dir = await stage(src, sha);
	try {
		return await ctx.write!(() => commitInstall(ctx, src, sha, dir));
	} finally {
		unstage(dir);
	}
}

function commitInstall(ctx: Ctx, src: ParsedSource, sha: string, dir: string): PluginRow {
	const manifest = readManifest(dir);
	if (!isCompatible(manifest.opal)) {
		throw conflict('incompatible_plugin', `Plugin ${manifest.id} needs OPAL ${manifest.opal}. This server is ${VERSION}.`);
	}
	const existing = findPlugin(ctx.db, manifest.id);
	if (existing && existing.source !== src.source) {
		throw conflict('plugin_source_differs', `Plugin ${manifest.id} is installed from ${existing.source}, not ${src.source}`);
	}
	// A local plugin changes in place: installing it again reads its manifest again.
	if (existing && existing.sha === sha && src.kind === 'github') return existing;

	if (src.kind === 'github') {
		const target = pluginDir(manifest.id, sha);
		mkdirSync(join(pluginsRoot(), manifest.id), { recursive: true });
		rmSync(target, { recursive: true, force: true });
		renameSync(dir, target);
	}

	if (!existing) {
		const userId = ensureUser(ctx, manifest);
		return insert(ctx, plugin, {
			key: manifest.id,
			source: src.source,
			ref: src.ref,
			sha,
			previousSha: null,
			version: manifest.version,
			manifest,
			enabled: false,
			userId
		});
	}

	const row = update(ctx, plugin, existing.id, {
		ref: src.ref,
		sha,
		previousSha: src.kind === 'github' ? existing.sha : null,
		version: manifest.version,
		manifest
	});
	update(ctx, user, existing.userId, { name: manifest.name });
	if (src.kind === 'github') {
		const keep = new Set([sha, existing.sha]);
		const root = join(pluginsRoot(), manifest.id);
		for (const name of readdirSync(root)) if (!keep.has(name)) rmSync(join(root, name), { recursive: true, force: true });
	}
	const defs = new Map(manifest.settings.map((s) => [s.key, s]));
	for (const s of ctx.db.select().from(pluginSetting).where(eq(pluginSetting.pluginId, row.id)).all()) {
		const def = defs.get(s.key);
		if (!def) {
			removeRow(ctx, pluginSetting, s.id);
		} else if (def.type === 'secret' && !s.secret) {
			// The new version calls this a secret, so the value it already has becomes one.
			update(ctx, pluginSetting, s.id, { secret: true, value: s.value === null ? null : sealSetting(row.key, s.key, s.value) });
			hideAuditedValue(ctx.db.$client, s.id, {
				op: ctx.op,
				invocation: ctx.invocation,
				actorUserId: actorUserId(ctx.actor),
				actorTokenId: ctx.actor.kind === 'token' ? ctx.actor.tokenId : null
			});
			markOldBytes(ctx.db.$client);
		}
	}
	if (row.enabled) runtime().start(row.key).catch(() => {});
	return row;
}

export async function remove(ctx: Ctx, key: string): Promise<void> {
	const row = getPlugin(ctx.db, key);
	await runtime().stop(key);
	for (const t of ctx.db
		.select()
		.from(apiToken)
		.where(and(eq(apiToken.userId, row.userId), isNull(apiToken.revokedAt)))
		.all()) {
		update(ctx, apiToken, t.id, { revokedAt: new Date().toISOString() });
	}
	for (const l of ctx.db.select().from(externalLink).where(eq(externalLink.pluginId, row.id)).all()) {
		removeRow(ctx, externalLink, l.id);
	}
	for (const s of ctx.db.select().from(pluginSetting).where(eq(pluginSetting.pluginId, row.id)).all()) {
		removeRow(ctx, pluginSetting, s.id);
	}
	removeRow(ctx, plugin, row.id);
	update(ctx, user, row.userId, { isActive: false });
	rmSync(join(pluginsRoot(), key), { recursive: true, force: true });
}

