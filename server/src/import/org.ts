/** Users, profiles, tokens, passkeys, roles, workcenters, settings and the project. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AVATAR_TYPES, now } from '@opal/shared';
import {
	apiToken,
	appSetting,
	authSetting,
	passkeyCredential,
	project,
	role,
	roleGate,
	user,
	userProfile,
	userRole,
	workcenter
} from '../db/schema/index.ts';
import { humanUsernameBase, isPluginUsername } from '../auth/tokens.ts';
import { AUTH_SETTING_KEYS } from '../db/schema/auth.ts';
import {
	type ImportCtx,
	bool,
	derived,
	fail,
	insertRows,
	json,
	readTable,
	ref,
	str,
	track,
	ts,
	tsReq,
	warn
} from './context.ts';

/** The plugin. prefix belongs to plugin identities; a 1.x person who holds it gets another name. */
const legacyUsername = (name: string) => isPluginUsername(name.trim().toLowerCase()) ? humanUsernameBase(name) : name;

const USER_COLS = [
	'id', 'username', 'name', 'email', 'password_hash', 'oidc_issuer', 'oidc_subject', 'is_active',
	'is_admin', 'created_at', 'updated_at',
	// the profile
	'job_title', 'phone', 'workcenter_id', 'avatar_filename', 'avatar_mime', 'avatar_source',
	'avatar_updated_at', 'needs_profile_setup', 'needs_onboarding'
];

function sniffMime(d: Uint8Array): (typeof AVATAR_TYPES)[number] | null {
	const at = (i: number, ...b: number[]) => b.every((v, k) => d[i + k] === v);
	if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
	return null;
}

/** workcenter, user, user_profile, api_token, passkey_credential. */
export function importPeople(c: ImportCtx): void {
	const wcRows = readTable(c, 'workcenter', ['id', 'name', 'code', 'description', 'location', 'is_active', 'created_at', 'updated_at']);
	track(c, 'workcenter', insertRows(c, 'workcenter', workcenter, wcRows.map((r) => ({
		id: Number(r.id),
		name: String(r.name),
		code: String(r.code),
		description: str(r.description),
		location: str(r.location),
		isActive: bool(r.is_active),
		createdAt: tsReq(r.created_at),
		updatedAt: tsReq(r.updated_at)
	}))));

	const users = readTable(c, 'user', USER_COLS);
	track(c, 'user', insertRows(c, 'user', user, users.map((r) => ({
		id: Number(r.id),
		username: legacyUsername(String(r.username)),
		name: String(r.name),
		email: str(r.email),
		passwordHash: str(r.password_hash),
		oidcIssuer: str(r.oidc_issuer),
		oidcSubject: str(r.oidc_subject),
		isActive: bool(r.is_active),
		isAdmin: bool(r.is_admin),
		createdAt: tsReq(r.created_at),
		updatedAt: tsReq(r.updated_at)
	}))));

	// One profile per user. An avatar file is copied to avatars/<sha256>.
	const profiles = users
		.filter((r) => c.ids.user!.has(Number(r.id)))
		.map((r) => {
			const id = Number(r.id);
			let hash: string | null = null;
			let mime: string | null = null;
			let source = str(r.avatar_source);
			if (r.avatar_filename && source !== 'removed') {
				const path = join(c.attachmentsDir, 'avatars', String(r.avatar_filename));
				if (existsSync(path)) {
					const bytes = readFileSync(path);
					hash = createHash('sha256').update(bytes).digest('hex');
					mime = sniffMime(bytes) ?? str(r.avatar_mime);
					mkdirSync(c.avatarsDir, { recursive: true });
					const out = join(c.avatarsDir, hash);
					if (!existsSync(out)) writeFileSync(out, bytes);
					source ??= 'upload';
				} else {
					warn(c, `user ${id}: avatar file ${String(r.avatar_filename)} is missing, avatar cleared`);
				}
			}
			return {
				userId: id,
				jobTitle: str(r.job_title),
				phone: str(r.phone),
				workcenterId: ref(c, 'workcenter', r.workcenter_id, `user ${id} workcenter_id`),
				avatarHash: hash,
				avatarMime: mime,
				avatarSource: hash || source === 'removed' ? source : null,
				avatarUpdatedAt: ts(r.avatar_updated_at),
				needsProfileSetup: bool(r.needs_profile_setup),
				needsOnboarding: bool(r.needs_onboarding),
				createdAt: tsReq(r.created_at),
				updatedAt: tsReq(r.updated_at)
			};
		});
	derived(c, 'user_profile', insertRows(c, 'user', userProfile, profiles, { count: false, idOf: (r) => r.userId }).length);

	const tokens = readTable(c, 'api_token', ['id', 'user_id', 'name', 'token_hash', 'last_used_at', 'expires_at', 'revoked_at', 'created_at']);
	insertRows(c, 'api_token', apiToken, tokens.map((r) => ({
		id: Number(r.id),
		userId: Number(r.user_id),
		name: String(r.name),
		tokenHash: String(r.token_hash),
		lastUsedAt: ts(r.last_used_at),
		expiresAt: ts(r.expires_at),
		revokedAt: ts(r.revoked_at),
		createdAt: tsReq(r.created_at)
	})));

	const keys = readTable(c, 'passkey_credential', ['id', 'user_id', 'credential_id', 'public_key', 'sign_count', 'name', 'aaguid', 'transports', 'last_used_at', 'created_at', 'updated_at']);
	insertRows(c, 'passkey_credential', passkeyCredential, keys.map((r) => ({
		id: Number(r.id),
		userId: Number(r.user_id),
		credentialId: Buffer.from(r.credential_id as Uint8Array),
		publicKey: Buffer.from(r.public_key as Uint8Array),
		signCount: Number(r.sign_count),
		name: String(r.name),
		aaguid: str(r.aaguid),
		transports: str(r.transports),
		lastUsedAt: ts(r.last_used_at),
		createdAt: tsReq(r.created_at),
		updatedAt: tsReq(r.updated_at)
	})));
}

/** role, user_role, role_gate. A soft-deleted role is left out with its grants. */
export function importRoles(c: ImportCtx): void {
	const roles = readTable(c, 'role', ['id', 'name', 'description', 'key', 'is_system', 'created_at', 'updated_at', 'deleted_at']);
	const live = roles.filter((r) => {
		if (r.deleted_at) {
			warn(c, `role ${Number(r.id)} "${String(r.name)}" was deleted, not imported`);
			return false;
		}
		return true;
	});
	track(c, 'role', insertRows(c, 'role', role, live.map((r) => ({
		id: Number(r.id),
		name: String(r.name),
		description: str(r.description),
		key: str(r.key),
		isSystem: bool(r.is_system),
		createdAt: tsReq(r.created_at),
		updatedAt: tsReq(r.updated_at)
	}))));

	const grants = readTable(c, 'user_role', ['id', 'user_id', 'role_id', 'granted_by_id', 'granted_at']);
	insertRows(c, 'user_role', userRole, grants
		.filter((r) => {
			const ok = c.ids.role!.has(Number(r.role_id)) && c.ids.user!.has(Number(r.user_id));
			if (!ok) warn(c, `user_role ${Number(r.id)}: user or role is not imported, grant skipped`);
			return ok;
		})
		.map((r) => ({
			id: Number(r.id),
			userId: Number(r.user_id),
			roleId: Number(r.role_id),
			grantedById: ref(c, 'user', r.granted_by_id, `user_role ${Number(r.id)} granted_by_id`),
			grantedAt: tsReq(r.granted_at)
		})));

	const gates = readTable(c, 'role_gate', ['id', 'role_id', 'gate']);
	insertRows(c, 'role_gate', roleGate, gates
		.filter((r) => c.ids.role!.has(Number(r.role_id)) || (warn(c, `role_gate ${Number(r.id)}: role is not imported, gate skipped`), false))
		.map((r) => ({ id: Number(r.id), roleId: Number(r.role_id), gate: String(r.gate) })));
}

/** app_setting: sign-in keys go to auth_setting, the rest stays in app_setting. */
export function importSettings(c: ImportCtx): void {
	const rows = readTable(c, 'app_setting', ['key', 'value', 'created_at', 'updated_at'], 'key');
	const authKeys: readonly string[] = AUTH_SETTING_KEYS;
	let auth = 0;
	let app = 0;
	for (const r of rows) {
		const base = { key: String(r.key), value: str(r.value), createdAt: tsReq(r.created_at), updatedAt: tsReq(r.updated_at) };
		try {
			if (authKeys.includes(base.key)) {
				c.d.insert(authSetting).values(base).run();
				auth++;
			} else {
				c.d.insert(appSetting).values(base).run();
				app++;
			}
		} catch (e) {
			fail(c, 'app_setting', 0, `${base.key}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	c.report.tables.app_setting!.imported = auth + app;
	derived(c, 'auth_setting', auth);
}

/** `MOJAVE SPHINX` to `MOJAVE-SPHINX`. */
export function projectCode(name: string): string {
	const slug = name
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24)
		.replace(/-+$/, '');
	return slug || 'PROJECT';
}

/**
 * The one project, from the legacy project configuration (app_setting `project_config`). The
 * organization settings are that same blob, already copied by importSettings.
 */
export function importProject(c: ImportCtx): number {
	const row = c.src.query("SELECT value FROM app_setting WHERE key = 'project_config'").get() as { value: string | null } | null;
	const cfg = json<{ name?: string; description?: string }>(row?.value) ?? {};
	const name = (cfg.name ?? '').trim() || 'Imported project';
	if (!cfg.name) warn(c, 'no project_config in the legacy database, project named "Imported project"');
	const at = now();
	const r = c.d
		.insert(project)
		.values({ code: projectCode(name), name, description: cfg.description?.trim() || null, state: 'active', createdAt: at, updatedAt: at })
		.returning({ id: project.id })
		.get();
	derived(c, 'project', 1);
	return r.id;
}
