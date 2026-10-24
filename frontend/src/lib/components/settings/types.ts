import { ApiError } from '#lib/api.js';

// Project, system and agent types come from the shared contracts (org area).
export type { AgentActivation, PartNumbering, ProjectConfig, SystemInfo, Tier } from '@opal/shared';

export interface AuthSettings {
	password_login_enabled: boolean;
	passkeys_enabled: boolean;
	oidc_enabled: boolean;
	oidc_issuer: string;
	oidc_client_id: string;
	has_client_secret: boolean;
	oidc_scopes: string;
	oidc_provider_name: string;
	oidc_groups_claim: string;
	oidc_admin_group: string;
	oidc_auto_create_users: boolean;
	oidc_redirect_base_url: string;
	callback_url: string;
}

export interface LifecycleState {
	demo_active: boolean;
	demo_file_exists: boolean;
	demo_db_path: string;
}

export interface ExtensionSummary {
	id: string;
	name: string;
	version: string;
	origin: string;
	enabled: boolean;
	compatible: boolean;
	provides: Record<string, number>;
	has_code: boolean;
}

export interface ExtensionList {
	items: ExtensionSummary[];
	broken: { directory: string; error: string }[];
	extension_dir: string;
	max_archive_bytes: number;
}

export interface ExtensionDetail extends ExtensionSummary {
	summary: string | null;
	author: string | null;
	license: string | null;
	homepage: string | null;
	requires: string;
	is_bundled: boolean;
	checksum: string | null;
	installed_at: string | null;
	path: string;
	declares: Record<string, boolean>;
	procedures: { key: string; name: string; type: string; steps: number }[];
	datasets: { key: string; name: string; fields: number }[];
	content_errors: string[];
}

export interface OnshapeSettings {
	configured: boolean;
	access_key: string;
	base_url: string;
	poll_interval_minutes: number;
	has_secret_key: boolean;
	has_webhook_secret: boolean;
}

export interface OnshapeDocument {
	name: string;
	document_id: string;
	workspace_id: string;
	element_id: string;
	element_type: string;
	auto_sync: boolean;
}

export interface OnshapeStatus {
	enabled: boolean;
	connected: boolean;
	documents: { name: string; document_id: string; element_id: string; auto_sync: boolean }[];
	poll_interval_minutes: number;
}

export interface SyncLog {
	id: number;
	started_at: string;
	completed_at: string | null;
	direction: string;
	trigger: string;
	status: string;
	document_id: string | null;
	parts_created: number;
	parts_updated: number;
	bom_lines_created: number;
	bom_lines_updated: number;
	bom_lines_removed: number;
	errors: Record<string, unknown> | null;
	summary: string | null;
}

/** 10485760 → 10 MB. */
export function bytes(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fetch that maps a 404 to null (an absent optional resource). */
export async function orNull<T>(p: Promise<T>): Promise<T | null> {
	try {
		return await p;
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) return null;
		throw e;
	}
}
