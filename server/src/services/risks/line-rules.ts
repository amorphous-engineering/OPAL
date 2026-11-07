/**
 * What a risk's state allows on its lines: its links to issues and its references. One rule, because
 * a risk link is one row with two doors: the risk's routes and the issue's. This file imports neither
 * side, so both can use it.
 */
import { conflict, type RiskDisposition } from '@opal/shared';

interface RiskState {
	riskNumber: string;
	disposition: RiskDisposition;
}

/** Lines stand once a person accepted the risk with them on the page. */
export const keepsItsLines = (disposition: RiskDisposition) =>
	disposition === 'accepted' || disposition === 'realized' || disposition === 'closed';

/** A realized or closed risk is finished paper: it takes no new lines. */
export function requireAddable(row: RiskState): void {
	if (row.disposition === 'realized' || row.disposition === 'closed') {
		throw conflict('risk_state', `${row.riskNumber} is ${row.disposition}, so it takes no new links or references`);
	}
}

export function requireRemovable(row: RiskState): void {
	if (keepsItsLines(row.disposition)) {
		throw conflict('risk_state', `${row.riskNumber} is ${row.disposition}, so its links and references stay`);
	}
}
