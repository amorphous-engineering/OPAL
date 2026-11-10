/**
 * Launch console prototype: a simulated vehicle, pad box, range and countdown, all in the browser.
 * Nothing here talks to hardware or to the server. It exists to try the console design before the
 * launch area gets operation contracts. LAUNCH.md has the design basis.
 *
 * Fail-safe asymmetry runs through every rule below: a move toward safe (hold, disarm, scrub) is one
 * action and always offered. A move toward hazard (arm, fire, resume) is gated, takes two separate
 * actions, and drops back to safe on any doubt.
 */

import type { LinkState } from '#lib/opal/link.js';

export type Answer = 'GO' | 'NO-GO' | null;
export type AlertLevel = 'warning' | 'caution' | 'advisory';
export type Phase = 'count' | 'hold' | 'awaiting-fire' | 'flight' | 'landed' | 'safed' | 'scrubbed';
export type FlightState = 'PAD' | 'BOOST' | 'COAST' | 'DROGUE' | 'MAIN' | 'LANDED';

export interface PollRole {
	id: string;
	role: string;
	person: string;
	answer: Answer;
	at: string | null;
	/** A GO from this role is a signature: a person attests the range is clear (humanOnly). */
	signs?: boolean;
}

export interface Criterion {
	id: string;
	label: string;
	value: string;
	limit: string;
	met: boolean;
}

export interface Callout {
	kind: 'warning' | 'caution' | 'note';
	text: string;
}

export interface CountStep {
	n: number;
	title: string;
	callouts?: Callout[];
	/** Earliest count time for this step, ms (negative = before T-0). */
	notBefore?: number;
	/** A reading the step records when it completes. */
	capture?: () => string;
	doneBy?: string;
	doneAt?: string;
	captured?: string;
}

export interface Alert {
	id: string;
	level: AlertLevel;
	text: string;
	at: string;
	acked: boolean;
}

export interface LogEntry {
	utc: string;
	t: string;
	actor: string;
	text: string;
	level?: AlertLevel | 'event';
}

export interface Sample {
	t: number;
	alt: number;
}

/** One telemetry frame, kept for the strip charts. `t` is count time in seconds. */
export interface Frame {
	t: number;
	alt: number;
	vel: number;
	acc: number;
	tilt: number;
	batt: number;
	rssi: number;
}

/** Flight phase times from the profile, s after ignition. The timeline shows them as predictions. */
export const PREDICTED: Record<Exclude<FlightState, 'PAD'>, number> = {
	BOOST: 0,
	COAST: 1.6,
	DROGUE: 11.9,
	MAIN: 44.7,
	LANDED: 78
};

/** The pad, and metres east/north of it as degrees. */
export const PAD = { lat: 35.4721, lon: -115.916 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((PAD.lat * Math.PI) / 180);

const START_MS = -180_000;
/** Built-in hold: the clock stops here until the poll is GO and the director resumes. */
const BUILT_IN_HOLD_MS = -60_000;
/** Software arm opens at this count time. */
const ARM_OPEN_MS = -30_000;
/** A hold after the built-in hold recycles the count to it. */
const RECYCLE_MS = BUILT_IN_HOLD_MS;
/** Telemetry older than this is stale; the console says so and the count holds. */
const STALE_MS = 1_500;
const FIRE_HOLD_MS = 1_000;

const WIND_LIMIT = 8.9; // m/s; 20 mph, the high-power safety code limit
const ME = 'A. Rivera';

export const iso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** T-time as people say it: T−00:01:42, T+00:00:07. */
export function tTime(ms: number): string {
	const sign = ms < 0 ? '−' : '+';
	const s = Math.floor(Math.abs(ms) / 1000);
	const hh = String(Math.floor(s / 3600)).padStart(2, '0');
	const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
	const ss = String(s % 60).padStart(2, '0');
	return `T${sign}${hh}:${mm}:${ss}`;
}

function noise(scale: number) {
	return (Math.random() - 0.5) * 2 * scale;
}

/** Simple point-mass profile: boost, drag-heavy coast, drogue, main. Good enough to drive a screen. */
function profile(t: number): {
	alt: number;
	vel: number;
	acc: number;
	state: FlightState;
} {
	const tb = 1.6;
	const a = 90;
	const vb = a * tb;
	const hb = 0.5 * a * tb * tb;
	const dec = 14;
	const tc = vb / dec;
	const apo = hb + vb * tc - 0.5 * dec * tc * tc;
	const mainAlt = 200;
	const vd = 20;
	const vm = 6;
	if (t < 0) return { alt: 0, vel: 0, acc: 0, state: 'PAD' };
	if (t < tb) return { alt: 0.5 * a * t * t, vel: a * t, acc: a, state: 'BOOST' };
	const t1 = t - tb;
	if (t1 < tc)
		return {
			alt: hb + vb * t1 - 0.5 * dec * t1 * t1,
			vel: vb - dec * t1,
			acc: -dec,
			state: 'COAST'
		};
	const t2 = t1 - tc;
	const tDrogue = (apo - mainAlt) / vd;
	if (t2 < tDrogue) return { alt: apo - vd * t2, vel: -vd, acc: 0, state: 'DROGUE' };
	const t3 = t2 - tDrogue;
	const alt = mainAlt - vm * t3;
	if (alt > 0) return { alt, vel: -vm, acc: 0, state: 'MAIN' };
	return { alt: 0, vel: 0, acc: 0, state: 'LANDED' };
}

export class LaunchSim {
	// Count
	clockMs = $state(START_MS);
	phase = $state<Phase>('count');
	holdReason = $state<string | null>(null);
	holdBy = $state<string | null>(null);
	/** Set when a hold after the built-in hold will recycle the count. */
	recycle = $state(false);
	windowCloses = new Date(Date.now() + 47 * 60_000);
	scrubReason = $state<string | null>(null);

	// Range and pad
	padKey = $state<'SAFE' | 'ARMED'>('SAFE');
	armed = $state(false);
	armedAt = $state<string | null>(null);
	firedAt = $state<string | null>(null);
	fireProgress = $state(0);
	gust = $state(false);
	linkDown = $state(false);
	contLost = $state(false);
	opalDown = $state(false);

	// OPAL link (through the plugin). The count never waits on it: entries queue and go in order.
	journalSent = $state(0);
	opalDroppedAt = $state<string | null>(null);
	opalBackAt = $state<string | null>(null);

	// Telemetry
	lastPacket = $state(Date.now());
	now = $state(Date.now());
	wind = $state(4.1);
	fcBatt = $state(8.12);
	padBatt = $state(12.6);
	igniterOhm = $state(1.9);
	drogueOhm = $state(2.4);
	mainOhm = $state(2.6);
	rssi = $state(-71);
	snr = $state(9.5);
	sats = $state(11);
	baroAlt = $state(0);
	vel = $state(0);
	acc = $state(0);
	tilt = $state(0.4);
	flight = $state<FlightState>('PAD');
	apogee = $state(0);
	samples = $state<Sample[]>([]);
	/** The last 120 s of frames at 10 Hz, on the pad and in flight. */
	frames = $state<Frame[]>([]);
	flightTimes = $state<Partial<Record<FlightState, number>>>({});

	// Attitude and TVC
	roll = $state(0);
	servoX = $state(0);
	servoY = $state(0);
	fcTemp = $state(31.4);
	logPct = $state(12);
	packetRate = $state(10);
	packetsLost = $state(0);

	// Position: metres east and north of the pad
	east = $state(0);
	north = $state(0);
	track = $state<{ e: number; n: number }[]>([]);
	windDir = 250; // degrees from: the wind blows toward 070

	// Pad box
	relay = $state<'OPEN' | 'CLOSED'>('OPEN');
	contTestAt = $state<string | null>(null);
	fireCurrent = $state(0);

	poll = $state<PollRole[]>([
		{ id: 'ld', role: 'Launch director', person: ME, answer: null, at: null },
		{
			id: 'rso',
			role: 'Range safety',
			person: 'J. Okafor',
			answer: null,
			at: null,
			signs: true
		},
		{ id: 'pad', role: 'Pad', person: 'M. Chen', answer: null, at: null },
		{ id: 'av', role: 'Avionics', person: 'S. Patel', answer: null, at: null },
		{ id: 'rec', role: 'Recovery', person: 'D. Haas', answer: null, at: null },
		{ id: 'wx', role: 'Weather', person: 'L. Novak', answer: null, at: null }
	]);

	steps = $state<CountStep[]>([
		{
			n: 1,
			title: 'Post the range at 30 m minimum distance',
			doneBy: 'M. Chen',
			doneAt: ''
		},
		{
			n: 2,
			title: 'Power the flight computer and confirm PAD_IDLE',
			doneBy: 'S. Patel',
			doneAt: '',
			captured: 'FC 8.14 V, PAD_IDLE'
		},
		{
			n: 3,
			title: 'Read recovery pyro continuity on telemetry',
			doneBy: 'S. Patel',
			doneAt: '',
			captured: 'Drogue 2.4 Ω, main 2.6 Ω'
		},
		{
			n: 4,
			title: 'Run the TVC servo sweep',
			doneBy: 'S. Patel',
			doneAt: '',
			captured: 'PASS, ±5.0° both axes'
		},
		{
			n: 5,
			title: 'Install the igniter with the pad key at SAFE',
			callouts: [
				{
					kind: 'warning',
					text: 'The pad key stays in your pocket while you are at the pad.'
				},
				{
					kind: 'note',
					text: 'Shunt the igniter leads until they are on the clips.'
				}
			],
			capture: () => `Igniter ${this.igniterOhm.toFixed(1)} Ω`,
			doneBy: 'M. Chen',
			doneAt: '',
			captured: 'Igniter 1.9 Ω'
		},
		{
			n: 6,
			title: 'Clear the pad crew to the safe distance',
			capture: () => `Pad crew at 30 m`,
			doneBy: 'M. Chen',
			doneAt: '',
			captured: 'Pad crew at 30 m'
		},
		{
			n: 7,
			title: 'Built-in hold: call the poll',
			notBefore: BUILT_IN_HOLD_MS,
			callouts: [{ kind: 'note', text: 'Every station answers. Silence is NO-GO.' }]
		},
		{
			n: 8,
			title: 'Turn the pad key to ARMED',
			callouts: [
				{
					kind: 'caution',
					text: 'Turn the key only after the RSO GO and with the range clear.'
				}
			],
			capture: () => `Pad key ${this.padKey}, igniter ${this.igniterOhm.toFixed(1)} Ω`
		},
		{
			n: 9,
			title: 'Arm ignition',
			notBefore: ARM_OPEN_MS
		},
		{ n: 10, title: 'Fire at T−0' },
		{ n: 11, title: 'Track the descent and call the landing' },
		{ n: 12, title: 'Safe the vehicle and record the landing position' }
	]);

	alerts = $state<Alert[]>([]);
	log = $state<LogEntry[]>([]);
	muted = $state(false);

	private timer: ReturnType<typeof setInterval> | null = null;
	private last = Date.now();
	private fireStart: number | null = null;
	private audio: AudioContext | null = null;
	private toneTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		const t0 = Date.now();
		this.steps.forEach((s, i) => {
			if (s.doneBy) s.doneAt = iso(new Date(t0 - (40 - i * 6) * 60_000));
		});
		this.say('System', 'Count resumed at T−00:03:00', 'event');
	}

	// ---- derived ----

	/** OFFLINE now; STALE latches after any drop until acknowledged, as in OPAL's status bar. */
	get opal(): LinkState {
		if (this.opalDown) return 'OFFLINE';
		return this.opalDroppedAt ? 'STALE' : 'ONLINE';
	}

	get journalQueued(): number {
		return this.log.length - this.journalSent;
	}

	ackOpal() {
		if (this.opalDown) return;
		this.opalDroppedAt = null;
		this.opalBackAt = null;
	}

	get range(): number {
		return Math.hypot(this.east, this.north);
	}

	/** Degrees true from the pad to the vehicle. */
	get bearing(): number {
		return ((Math.atan2(this.east, this.north) * 180) / Math.PI + 360) % 360;
	}

	get lat(): number {
		return PAD.lat + this.north / M_PER_DEG_LAT;
	}

	get lon(): number {
		return PAD.lon + this.east / M_PER_DEG_LON;
	}

	/** Where the vehicle lands if the wind holds: drift for the descent time left. */
	get predicted(): { e: number; n: number } | null {
		if (this.flight !== 'DROGUE' && this.flight !== 'MAIN' && this.flight !== 'COAST') return null;
		const left = Math.max(0, PREDICTED.LANDED - this.clockMs / 1000);
		const to = ((this.windDir + 180) * Math.PI) / 180;
		const d = left * this.wind * 0.9;
		return { e: this.east + Math.sin(to) * d, n: this.north + Math.cos(to) * d };
	}

	/** Continuity test: a small current through each channel, read back as resistance. */
	contTest() {
		this.contTestAt = iso();
		this.say(
			'Pad box',
			`Continuity test: igniter ${this.igniterOhm.toFixed(1)} Ω, drogue ${this.drogueOhm.toFixed(1)} Ω, main ${this.mainOhm.toFixed(1)} Ω`
		);
	}

	get current(): CountStep | undefined {
		return this.steps.find((s) => !s.doneBy);
	}

	get stale(): boolean {
		return this.now - this.lastPacket > STALE_MS;
	}

	get packetAge(): number {
		return this.now - this.lastPacket;
	}

	get criteria(): Criterion[] {
		const left = this.windowCloses.getTime() - this.now;
		return [
			{
				id: 'wind',
				label: 'Surface wind',
				value: `${this.wind.toFixed(1)} m/s`,
				limit: `≤ ${WIND_LIMIT} m/s`,
				met: this.wind <= WIND_LIMIT
			},
			{
				id: 'window',
				label: 'Airspace window',
				value: left > 0 ? `${Math.floor(left / 60_000)} min left` : 'Closed',
				limit: '> 0 min',
				met: left > 0
			},
			{
				id: 'ceiling',
				label: 'Cloud ceiling',
				value: '1 800 m',
				limit: '≥ 1 500 m',
				met: true
			},
			{
				id: 'link',
				label: 'Telemetry link',
				value: this.stale ? `Stale ${(this.packetAge / 1000).toFixed(1)} s` : `${this.rssi} dBm`,
				limit: `< ${STALE_MS / 1000} s old`,
				met: !this.stale
			},
			{
				id: 'cont',
				label: 'Igniter continuity',
				value: `${this.igniterOhm.toFixed(1)} Ω`,
				limit: '0.5 to 5.0 Ω',
				met: this.igniterOhm >= 0.5 && this.igniterOhm <= 5
			}
		];
	}

	get criteriaMet(): boolean {
		return this.criteria.every((c) => c.met);
	}

	get pollGo(): boolean {
		return this.poll.every((p) => p.answer === 'GO');
	}

	get rsoGo(): boolean {
		return this.poll.find((p) => p.id === 'rso')?.answer === 'GO';
	}

	/** Each interlock for ARM, in the order the operator checks them. */
	get interlocks(): { label: string; met: boolean }[] {
		const cur = this.current?.n ?? 99;
		return [
			{
				label: 'Count at T−00:00:30 or later',
				met: this.clockMs >= ARM_OPEN_MS
			},
			{ label: 'Poll all GO', met: this.pollGo },
			{ label: 'Launch commit criteria met', met: this.criteriaMet },
			{ label: 'Pad key ARMED', met: this.padKey === 'ARMED' },
			{ label: 'Flight computer PAD_READY', met: this.fcState === 'PAD_READY' },
			{ label: 'OPAL WO-0041 steps 1 to 8 complete', met: cur >= 9 }
		];
	}

	get canArm(): boolean {
		return (
			!this.armed &&
			(this.phase === 'count' || this.phase === 'awaiting-fire') &&
			this.interlocks.every((i) => i.met)
		);
	}

	get armBlock(): string | null {
		if (this.armed) return null;
		if (this.phase === 'hold') return 'The count is on hold.';
		const miss = this.interlocks.find((i) => !i.met);
		return miss ? `${miss.label}: not met.` : null;
	}

	get canFire(): boolean {
		return this.armed && this.phase === 'awaiting-fire';
	}

	get fcState(): string {
		if (this.phase === 'flight' || this.phase === 'landed' || this.phase === 'safed')
			return this.flight;
		return this.padKey === 'ARMED' && this.drogueOhm < 5 && this.mainOhm < 5
			? 'PAD_READY'
			: 'PAD_IDLE';
	}

	get unackedWarning(): boolean {
		return this.alerts.some((a) => a.level === 'warning' && !a.acked);
	}

	get unackedCaution(): boolean {
		return this.alerts.some((a) => a.level === 'caution' && !a.acked);
	}

	get atBuiltInHold(): boolean {
		return this.phase === 'hold' && this.holdReason === 'Built-in hold';
	}

	get canResume(): boolean {
		return this.phase === 'hold' && this.pollGo && this.criteriaMet && !this.stale;
	}

	get resumeBlock(): string | null {
		if (this.phase !== 'hold') return null;
		if (!this.criteriaMet) {
			const c = this.criteria.find((x) => !x.met);
			return `${c?.label}: ${c?.value}, limit ${c?.limit}.`;
		}
		if (!this.pollGo) return 'The poll is not all GO.';
		return null;
	}

	// ---- loop ----

	start() {
		if (this.timer) return;
		this.last = Date.now();
		this.timer = setInterval(() => this.tick(), 100);
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.stopTone();
		void this.audio?.close();
	}

	private tick() {
		const t = Date.now();
		const dt = t - this.last;
		this.last = t;
		this.now = t;

		if (!this.linkDown) {
			this.lastPacket = t;
			this.rssi = Math.round(-71 + noise(2) - (this.phase === 'flight' ? this.baroAlt / 60 : 0));
			this.snr = +(9.5 + noise(0.6)).toFixed(1);
			this.wind = Math.max(0, (this.gust ? 10.6 : 4.1) + noise(0.5));
			this.fcBatt = +(8.12 + noise(0.01)).toFixed(2);
			this.padBatt = +(12.6 + noise(0.02)).toFixed(2);
			this.igniterOhm = this.contLost ? 99.9 : +(1.9 + noise(0.04)).toFixed(2);
			if (this.phase !== 'flight' && this.phase !== 'landed') {
				this.tilt = +(0.4 + noise(0.05)).toFixed(2);
				this.roll = +noise(0.3).toFixed(1);
				this.servoX = 0;
				this.servoY = 0;
			}
			this.fcTemp = +(31.4 + noise(0.1) + (this.phase === 'flight' ? 2 : 0)).toFixed(1);
			this.packetRate = 10;
		} else {
			this.packetRate = 0;
			if (Math.random() < 0.1) this.packetsLost += 1;
		}
		if (this.relay === 'CLOSED' && this.firedAt && t - Date.parse(this.firedAt) > 1000) {
			this.relay = 'OPEN';
			this.fireCurrent = 0;
		}

		if (this.phase === 'count') {
			this.clockMs += dt;
			if (this.clockMs >= BUILT_IN_HOLD_MS && this.clockMs - dt < BUILT_IN_HOLD_MS) {
				this.clockMs = BUILT_IN_HOLD_MS;
				this.enterHold('Built-in hold', 'System');
			} else if (this.clockMs >= 0) {
				this.clockMs = 0;
				this.phase = 'awaiting-fire';
				this.say('System', 'T−0. Awaiting FIRE', 'event');
			}
		}
		if (this.phase === 'flight' || this.phase === 'landed') {
			this.clockMs += dt;
			const p = profile(this.clockMs / 1000);
			if (!this.linkDown) {
				this.baroAlt = Math.max(0, p.alt + noise(1.5));
				this.vel = p.vel;
				this.acc = p.acc;
				this.apogee = Math.max(this.apogee, p.alt);
				this.samples = [...this.samples, { t: this.clockMs / 1000, alt: this.baroAlt }].slice(
					-1200
				);
				const ft = this.clockMs / 1000;
				// Attitude: weathercocks a little in boost, pitches over in coast, swings under canopy.
				if (p.state === 'BOOST') this.tilt = +(1 + ft * 0.8 + noise(0.2)).toFixed(1);
				else if (p.state === 'COAST') this.tilt = +(2.3 + (ft - 1.6) * 1.6 + noise(0.3)).toFixed(1);
				else if (p.state === 'LANDED') this.tilt = 90;
				else this.tilt = +(15 + noise(12)).toFixed(1);
				this.roll = +(
					p.state === 'BOOST' || p.state === 'COAST' ? 40 + noise(8) : noise(20)
				).toFixed(1);
				this.servoX = p.state === 'BOOST' ? +(1.6 * Math.sin(ft * 9) + noise(0.2)).toFixed(1) : 0;
				this.servoY = p.state === 'BOOST' ? +(1.1 * Math.cos(ft * 7) + noise(0.2)).toFixed(1) : 0;
				this.logPct = Math.min(100, +(12 + ft * 0.3).toFixed(1));
				// Drift downwind under canopy, a little upwind weathercock in boost.
				const to = ((this.windDir + 180) * Math.PI) / 180;
				const under = p.state === 'DROGUE' || p.state === 'MAIN';
				const v = under ? this.wind * 0.9 : p.state === 'COAST' ? 3 : 0;
				if (p.state !== 'LANDED') {
					this.east += Math.sin(to) * v * (dt / 1000);
					this.north += Math.cos(to) * v * (dt / 1000);
					if (this.track.length === 0 || this.samples.length % 5 === 0)
						this.track = [...this.track, { e: this.east, n: this.north }];
				}
			}
			if (p.state !== this.flight) this.flightEvent(p.state);
		}

		if (!this.linkDown)
			this.frames = [
				...this.frames.filter((f) => f.t > this.clockMs / 1000 - 120),
				{
					t: this.clockMs / 1000,
					alt: this.baroAlt,
					vel: this.vel,
					acc: this.acc,
					tilt: this.tilt,
					batt: this.fcBatt,
					rssi: this.rssi
				}
			];

		// Crew work on the OPAL execution: step 8 closes there when the key turns after the RSO GO.
		const s8 = this.steps[7];
		if (!s8.doneBy && this.steps[6].doneBy && this.rsoGo && this.padKey === 'ARMED') {
			s8.doneBy = 'M. Chen';
			s8.doneAt = iso();
			s8.captured = s8.capture?.();
			this.say('OPAL', `WO-0041 step 8 complete by M. Chen`);
		}

		// The count holds itself on a broken commit criterion, and drops the arm.
		if (this.phase === 'count' || this.phase === 'awaiting-fire') {
			const bad = this.criteria.find((c) => !c.met);
			if (bad && this.clockMs > START_MS + 500) {
				this.raise(
					bad.id === 'cont' && this.armed ? 'warning' : 'caution',
					`${bad.label} out of limit: ${bad.value}`,
					bad.id
				);
				this.enterHold(`${bad.label}: ${bad.value}`, 'System');
			}
		}
		// Clear alerts whose condition ended. An acknowledged alert leaves; an unacknowledged one
		// stays lit, because the operator may have missed it (it latches, like STALE).
		for (const c of this.criteria) {
			if (c.met) this.alerts = this.alerts.filter((a) => !(a.id === c.id && a.acked));
		}
		if (this.phase === 'flight' && this.stale)
			this.raise('caution', 'Telemetry stale in flight', 'link');
		if (this.sats < 6) this.raise('advisory', `GPS ${this.sats} satellites`, 'gps');

		if (!this.opalDown) this.journalSent = this.log.length;

		if (this.fireStart !== null) {
			this.fireProgress = Math.min(1, (t - this.fireStart) / FIRE_HOLD_MS);
			if (this.fireProgress >= 1) this.ignite();
		}
	}

	// ---- acts ----

	say(actor: string, text: string, level?: LogEntry['level']) {
		this.log = [{ utc: iso(), t: tTime(this.clockMs), actor, text, level }, ...this.log].slice(
			0,
			300
		);
	}

	raise(level: AlertLevel, text: string, id: string) {
		const open = this.alerts.find((a) => a.id === id);
		if (open && open.level === level) return;
		this.alerts = [
			{ id, level, text, at: iso(), acked: false },
			...this.alerts.filter((a) => a.id !== id)
		];
		this.say('System', text, level);
		this.sound();
	}

	/** HOLD is one action for anyone, at any time before ignition. It also safes the arm. */
	hold(reason = 'Called by operator', by = ME) {
		if (this.phase !== 'count' && this.phase !== 'awaiting-fire') return;
		this.enterHold(reason, by);
	}

	private enterHold(reason: string, by: string) {
		if (this.phase === 'hold') return;
		this.phase = 'hold';
		this.holdReason = reason;
		this.holdBy = by;
		this.recycle = this.clockMs > RECYCLE_MS;
		if (this.armed) this.disarm('Hold');
		this.say(by, `HOLD at ${tTime(this.clockMs)}: ${reason}`, 'event');
	}

	resume() {
		if (!this.canResume) return;
		if (this.recycle) {
			this.clockMs = RECYCLE_MS + 1;
			this.say(ME, `Recycle to ${tTime(RECYCLE_MS)}`, 'event');
		} else if (this.clockMs <= BUILT_IN_HOLD_MS) {
			this.clockMs = BUILT_IN_HOLD_MS + 1;
		}
		this.phase = 'count';
		this.holdReason = null;
		this.holdBy = null;
		this.recycle = false;
		const s = this.steps.find((x) => x.n === 7);
		if (s && !s.doneBy) this.stamp(s);
		this.say(ME, `Count resumed at ${tTime(this.clockMs)}`, 'event');
	}

	answer(id: string, a: Answer) {
		const p = this.poll.find((x) => x.id === id);
		if (!p) return;
		p.answer = a;
		p.at = a ? iso() : null;
		this.say(p.person, `${p.role}: ${a ?? 'withdrawn'}`, a === 'NO-GO' ? 'caution' : 'event');
		if (a === 'NO-GO') this.hold(`${p.role} NO-GO`, p.person);
	}

	callPoll() {
		for (const p of this.poll) {
			p.answer = null;
			p.at = null;
		}
		this.say(ME, 'Poll called', 'event');
	}

	completeStep() {
		const s = this.current;
		if (!s || !this.stepReady(s)) return;
		if (s.n === 8 && this.padKey !== 'ARMED') return;
		this.stamp(s);
	}

	stepReady(s: CountStep): boolean {
		if (s.notBefore !== undefined && this.clockMs < s.notBefore) return false;
		if (s.n === 7) return false; // closes with RESUME
		if (s.n === 8) return this.rsoGo && this.padKey === 'ARMED';
		if (s.n === 9 || s.n === 10) return false; // closes with ARM and FIRE
		if (s.n === 11) return this.flight === 'LANDED';
		if (s.n === 12) return this.phase === 'landed';
		return true;
	}

	stepBlock(s: CountStep): string | null {
		if (s.notBefore !== undefined && this.clockMs < s.notBefore)
			return `Opens at ${tTime(s.notBefore)}.`;
		if (s.n === 8 && !this.rsoGo) return 'Waiting on the RSO GO.';
		if (s.n === 8 && this.padKey !== 'ARMED') return 'The pad key reads SAFE.';
		if (s.n === 11 && this.flight !== 'LANDED') return 'The vehicle is in flight.';
		return null;
	}

	private stamp(s: CountStep) {
		s.doneBy = ME;
		s.doneAt = iso();
		if (s.capture) s.captured = s.capture();
		this.say(ME, `Step ${s.n} complete: ${s.title}${s.captured ? ` (${s.captured})` : ''}`);
	}

	arm() {
		if (!this.canArm) return;
		this.armed = true;
		this.armedAt = iso();
		this.stamp(this.steps[8]);
		this.say(ME, 'Ignition ARMED', 'event');
	}

	/** SAFE is one action and always offered while armed. */
	disarm(why = 'Operator') {
		if (!this.armed) return;
		this.armed = false;
		this.armedAt = null;
		this.firePress(false);
		const s = this.steps[8];
		if (s.doneBy && this.phase !== 'flight') {
			s.doneBy = undefined;
			s.doneAt = undefined;
		}
		this.say(why === 'Operator' ? ME : 'System', `Ignition SAFE (${why})`, 'event');
	}

	/** FIRE is a press held for one second on an armed console: a second, separate act. */
	firePress(down: boolean) {
		if (down && this.canFire) {
			this.fireStart = Date.now();
		} else {
			this.fireStart = null;
			this.fireProgress = 0;
		}
	}

	private ignite() {
		this.fireStart = null;
		this.fireProgress = 0;
		this.firedAt = iso();
		this.relay = 'CLOSED';
		this.fireCurrent = 6.2;
		this.armed = false;
		this.phase = 'flight';
		this.clockMs = 0;
		this.stamp(this.steps[9]);
		this.say(ME, 'FIRE. Ignition commanded', 'event');
		this.say('System', 'Motor AT-H128W lot 2207 consumed from stock', 'event');
	}

	private flightEvent(next: FlightState) {
		this.flight = next;
		this.flightTimes = { ...this.flightTimes, [next]: this.clockMs / 1000 };
		const text: Record<FlightState, string> = {
			PAD: '',
			BOOST: 'Liftoff',
			COAST: 'Burnout',
			DROGUE: `Apogee ${Math.round(this.apogee)} m AGL. Drogue fired`,
			MAIN: 'Main fired at 200 m AGL',
			LANDED: 'Landed'
		};
		if (next === 'LANDED') this.phase = 'landed';
		this.say('Vehicle', text[next], 'event');
	}

	safeVehicle() {
		const s = this.steps[11];
		if (this.phase !== 'landed' || s.doneBy) return;
		const done = this.steps[10];
		if (!done.doneBy) this.stamp(done);
		s.capture = () => '35.4721 N, 115.9123 W, 412 m from pad';
		this.stamp(s);
		this.phase = 'safed';
		this.say(ME, 'Vehicle safe. Flight record closed', 'event');
	}

	scrub(reason: string) {
		if (!reason.trim() || this.phase === 'flight' || this.phase === 'landed') return;
		this.disarm('Scrub');
		this.phase = 'scrubbed';
		this.scrubReason = reason.trim();
		this.say(ME, `SCRUB: ${reason.trim()}`, 'event');
	}

	ack(level: AlertLevel) {
		this.alerts = this.alerts
			.map((a) => (a.level === level ? { ...a, acked: true } : a))
			.filter((a) => !(a.acked && this.criteria.find((c) => c.id === a.id)?.met));
		if (!this.unackedWarning && !this.unackedCaution) this.stopTone();
		this.say(ME, `MASTER ${level.toUpperCase()} acknowledged`);
	}

	// ---- sim faults (prototype only) ----

	toggle(fault: 'gust' | 'linkDown' | 'contLost' | 'opalDown') {
		this[fault] = !this[fault];
		if (fault === 'opalDown') {
			if (this.opalDown && (!this.opalDroppedAt || this.opalBackAt)) {
				this.opalDroppedAt = iso();
				this.opalBackAt = null;
			}
			if (!this.opalDown) this.opalBackAt = iso();
		}
		this.say('Sim', `${fault} ${this[fault] ? 'on' : 'off'}`);
	}

	turnPadKey() {
		this.padKey = this.padKey === 'SAFE' ? 'ARMED' : 'SAFE';
		this.say('Pad box', `Pad key ${this.padKey}`, 'event');
		if (this.padKey === 'SAFE' && this.armed) this.disarm('Pad key SAFE');
	}

	// ---- sound: a warning repeats until acknowledged, a caution sounds once ----

	private sound() {
		if (this.muted || typeof window === 'undefined') return;
		try {
			this.audio ??= new AudioContext();
		} catch {
			return;
		}
		if (this.unackedWarning) {
			if (this.toneTimer) return;
			const beep = () => this.beep([880, 660], 0.18);
			beep();
			this.toneTimer = setInterval(beep, 900);
		} else if (this.unackedCaution) {
			this.beep([740], 0.3);
		}
	}

	private beep(freqs: number[], len: number) {
		const ctx = this.audio;
		if (!ctx) return;
		freqs.forEach((f, i) => {
			const o = ctx.createOscillator();
			const g = ctx.createGain();
			o.frequency.value = f;
			o.type = 'square';
			g.gain.value = 0.04;
			o.connect(g).connect(ctx.destination);
			const at = ctx.currentTime + i * len;
			o.start(at);
			o.stop(at + len * 0.9);
		});
	}

	private stopTone() {
		if (this.toneTimer) clearInterval(this.toneTimer);
		this.toneTimer = null;
	}
}

let shared: LaunchSim | null = null;

/** The one simulated flight in this tab. The status bar and the console read the same one. */
export function flightSim(): LaunchSim {
	shared ??= new LaunchSim();
	shared.start();
	return shared;
}
