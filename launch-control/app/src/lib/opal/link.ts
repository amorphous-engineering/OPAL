/**
 * The contract between Launch Control and OPAL. Launch Control never calls OPAL's own API.
 * It calls the launch-control plugin at <OPAL>/plugins/launch-control/api/*, and the plugin
 * calls OPAL with its scoped token. launch-control/plugin implements the server side.
 *
 * The count never waits on OPAL. Launch Control keeps the journal locally and sends it in order.
 * A lost link shows as STALE or OFFLINE in the status bar and changes nothing on the pad.
 *
 * Signatures stay in OPAL (humanOnly): the RSO signs the poll step on the execution in OPAL,
 * and Launch Control reads that signature here. Launch Control cannot sign for anyone.
 */

/**
 * One step of the released procedure, as the execution in OPAL holds it. Read-only here: the crew
 * completes steps in OPAL. Launch Control reads them for the ARM interlock and the procedure line.
 */
export interface LinkedStep {
	n: number;
	title: string;
	callouts: { kind: 'warning' | 'caution' | 'note'; text: string }[];
	/** Earliest count time for the step, ms from T-0. Authored on the procedure step. */
	notBefore?: number;
	/** A sign-off slot on this step: the role that signs it in OPAL. */
	signoff?: string;
	status: 'pending' | 'completed' | 'skipped';
	doneBy?: string;
	doneAt?: string;
	captured?: string;
}

export interface LinkedSignature {
	step: number;
	role: string;
	person: string;
	at: string;
}

/** GET /api/flights/:number */
export interface LinkedFlight {
	number: string; // FLT-0007, display width from OPAL
	title: string;
	project: string;
	execution: { number: string; url: string }; // WO-0041
	procedure: { number: string; revision: string; title: string; url: string };
	vehicle: { part: string; serial: string; title: string };
	flightComputer: { part: string; serial: string };
	motor: {
		part: string;
		lot: string;
		qty: string;
		uom: string;
		state: 'allocated' | 'consumed';
	};
	dataset: { number: string; url: string };
	requirements: { number: string; title: string; target: string }[];
	risks: { number: string; title: string; state: string }[];
	steps: LinkedStep[];
	signatures: LinkedSignature[];
}

/** One entry of the count journal. Sent in order, each once, keyed by `seq`. */
export type JournalEntry =
	| {
			seq: number;
			at: string;
			t: number;
			kind: 'hold' | 'resume' | 'scrub';
			by: string;
			reason?: string;
	  }
	| {
			seq: number;
			at: string;
			t: number;
			kind: 'poll';
			role: string;
			by: string;
			answer: 'GO' | 'NO-GO' | null;
	  }
	| {
			seq: number;
			at: string;
			t: number;
			kind: 'arm' | 'safe' | 'fire';
			by: string;
	  }
	| { seq: number; at: string; t: number; kind: 'flight'; state: string }
	| {
			seq: number;
			at: string;
			t: number;
			kind: 'alert';
			level: string;
			text: string;
	  };

/**
 * Plugin routes, below <OPAL>/plugins/launch-control:
 *
 *   GET  /api/flights                      flights with their execution and state
 *   GET  /api/flights/:number              LinkedFlight
 *   POST /api/flights                      { procedure, project, vehicleSerial, motorLot } -> cuts the
 *                                          work order from the released procedure, links it, returns LinkedFlight
 *   POST /api/flights/:number/journal      { entries: JournalEntry[] } -> { accepted: number } (idempotent by seq)
 *   POST /api/flights/:number/samples      { rows: [t, alt, vel, acc, ...][] } -> appended to the dataset
 *   GET  /panel/execution?execution=<id>   the execution.side panel in OPAL
 */
export const PLUGIN_BASE = '/plugins/launch-control';

export type LinkState = 'ONLINE' | 'STALE' | 'OFFLINE';

/** Where OPAL answers. Record links in Launch Control open there, in a new tab. */
export const OPAL_URL: string = import.meta.env.VITE_OPAL_URL ?? 'http://localhost:5173';

export const opalHref = (path: string) => `${OPAL_URL}${path}`;
