/**
 * Claim links set a password on an account that has none, and who can sign in at all. A person
 * from before OPAL had passwords arrives with no way in, and if that includes every administrator
 * there is nobody to make links for the others.
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { signPayload } from '../../auth/signing.ts';
import type { Db } from '../../db/client.ts';
import { auditLog, passkeyCredential, user } from '../../db/schema/index.ts';
import type { ImportReport } from '../../import/context.ts';
import { oidcActive, readSettings } from './settings.ts';

export const CLAIM_LINK_TTL_MS = 7 * 86_400_000;

/**
 * A link printed at a start ends up in logs, where it gives whoever reads them an administrator. So it
 * lasts hours, not days, and it dies with the process that printed it, as the setup code does.
 */
export const PRINTED_LINK_TTL_MS = 12 * 3_600_000;
const THIS_START = randomBytes(16).toString('base64url');

export const fromThisStart = (start: unknown): boolean => start === THIS_START;

type Account = typeof user.$inferSelect;

export function claimToken(u: Pick<Account, 'id' | 'createdAt' | 'updatedAt'>): string {
	return signPayload({ kind: 'account-claim', uid: u.id, born: u.createdAt, rev: u.updatedAt }, CLAIM_LINK_TTL_MS);
}

function canSignIn(db: Db, u: Account, oidc: boolean): boolean {
	if (u.passwordHash || (oidc && u.oidcSubject)) return true;
	return !!db.select({ id: passkeyCredential.id }).from(passkeyCredential).where(eq(passkeyCredential.userId, u.id)).limit(1).get();
}

/**
 * Active people with no way in, after an import. When nobody active is an administrator, the
 * oldest active account becomes one, as 1.x did when it added the flag: otherwise nothing in the
 * app could ever change that.
 */
export function noSignInPeople(db: Db, report: ImportReport): ImportReport['noSignIn'] {
	const oidc = oidcActive(readSettings(db));
	const people = db.select().from(user).where(eq(user.isActive, true)).orderBy(user.id).all();
	const first = people[0];
	if (first && !people.some((p) => p.isAdmin)) {
		db.update(user).set({ isAdmin: true }).where(eq(user.id, first.id)).run();
		first.isAdmin = true;
		report.warnings.push(`user ${first.id} "${first.username}" made an administrator: no active account was one`);
	}
	if (!first) report.warnings.push('no active account: nobody can sign in to this database');
	return people.filter((p) => !canSignIn(db, p, oidc)).map((p) => ({ id: p.id, username: p.username, isAdmin: p.isAdmin }));
}

function printedToken(u: Pick<Account, 'id' | 'createdAt' | 'updatedAt'>): string {
	return signPayload({ kind: 'printed-claim', uid: u.id, born: u.createdAt, rev: u.updatedAt, start: THIS_START }, PRINTED_LINK_TTL_MS);
}

/**
 * One link per administrator of an imported database, when no active administrator can sign in. A person
 * from before OPAL had passwords needs one. Nothing else gets a printed link: not a database that was
 * never imported, where this would only be a way around how it signs people in, and not an account tied
 * to single sign-on, which a password would step around.
 */
export function firstAdminClaimLinks(db: Db, baseUrl: string): { username: string; url: string }[] {
	const settings = readSettings(db);
	if (!settings.passwordLoginEnabled) return [];
	const oidc = oidcActive(settings);
	const admins = db.select().from(user).where(and(eq(user.isActive, true), eq(user.isAdmin, true))).orderBy(user.id).all();
	if (admins.some((a) => canSignIn(db, a, oidc))) return [];
	if (!db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.op, 'legacy.import')).limit(1).get()) return [];
	return admins.filter((a) => !a.oidcSubject).map((a) => ({ username: a.username, url: `${baseUrl}/claim?token=${encodeURIComponent(printedToken(a))}` }));
}
