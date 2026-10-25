/**
 * Units of measure for captured data: the one list (the idea of Pint's registry, kept small).
 *
 * A field stores the unit `code`; people see the `symbol`. Each unit has a dimension and a
 * factor (and for temperature an offset) to the dimension's SI unit, so a value converts only
 * within its dimension: SI = value * factor + offset.
 *
 * The list is data. Add a unit by adding a row; never change or reuse a code, because stored
 * fields name units by code.
 */

export const UNIT_DIMENSIONS = [
	'length',
	'area',
	'volume',
	'mass',
	'force',
	'torque',
	'pressure',
	'temperature',
	'time',
	'frequency',
	'speed',
	'flow',
	'angle',
	'voltage',
	'current',
	'resistance',
	'capacitance',
	'power',
	'energy',
	'ratio',
	'count'
] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

export interface Unit {
	code: string;
	symbol: string;
	name: string;
	dimension: UnitDimension;
	/** To the SI unit of the dimension: si = value * factor + offset. */
	factor: number;
	offset?: number;
}

const u = (code: string, symbol: string, name: string, dimension: UnitDimension, factor: number, offset?: number): Unit =>
	offset === undefined ? { code, symbol, name, dimension, factor } : { code, symbol, name, dimension, factor, offset };

const IN = 0.0254;
const LBF = 4.4482216152605;
const OZF = LBF / 16;

export const UNITS: readonly Unit[] = [
	// length (m)
	u('um', 'µm', 'micrometre', 'length', 1e-6),
	u('mm', 'mm', 'millimetre', 'length', 1e-3),
	u('cm', 'cm', 'centimetre', 'length', 1e-2),
	u('m', 'm', 'metre', 'length', 1),
	u('km', 'km', 'kilometre', 'length', 1e3),
	u('mil', 'mil', 'thousandth of an inch', 'length', IN / 1000),
	u('in', 'in', 'inch', 'length', IN),
	u('ft', 'ft', 'foot', 'length', 0.3048),
	u('yd', 'yd', 'yard', 'length', 0.9144),
	// area (m²)
	u('mm2', 'mm²', 'square millimetre', 'area', 1e-6),
	u('cm2', 'cm²', 'square centimetre', 'area', 1e-4),
	u('m2', 'm²', 'square metre', 'area', 1),
	u('in2', 'in²', 'square inch', 'area', IN * IN),
	u('ft2', 'ft²', 'square foot', 'area', 0.09290304),
	// volume (m³)
	u('ml', 'mL', 'millilitre', 'volume', 1e-6),
	u('l', 'L', 'litre', 'volume', 1e-3),
	u('cm3', 'cm³', 'cubic centimetre', 'volume', 1e-6),
	u('in3', 'in³', 'cubic inch', 'volume', IN * IN * IN),
	u('floz', 'fl oz', 'US fluid ounce', 'volume', 2.95735295625e-5),
	u('gal', 'gal', 'US gallon', 'volume', 3.785411784e-3),
	// mass (kg)
	u('mg', 'mg', 'milligram', 'mass', 1e-6),
	u('g', 'g', 'gram', 'mass', 1e-3),
	u('kg', 'kg', 'kilogram', 'mass', 1),
	u('oz', 'oz', 'ounce', 'mass', 0.028349523125),
	u('lb', 'lb', 'pound', 'mass', 0.45359237),
	// force (N)
	u('n', 'N', 'newton', 'force', 1),
	u('kn', 'kN', 'kilonewton', 'force', 1e3),
	u('ozf', 'ozf', 'ounce-force', 'force', OZF),
	u('lbf', 'lbf', 'pound-force', 'force', LBF),
	u('kgf', 'kgf', 'kilogram-force', 'force', 9.80665),
	// torque (N·m)
	u('n_cm', 'N·cm', 'newton centimetre', 'torque', 1e-2),
	u('n_m', 'N·m', 'newton metre', 'torque', 1),
	u('in_ozf', 'in·ozf', 'inch ounce-force', 'torque', IN * OZF),
	u('in_lbf', 'in·lbf', 'inch pound-force', 'torque', IN * LBF),
	u('ft_lbf', 'ft·lbf', 'foot pound-force', 'torque', 0.3048 * LBF),
	// pressure (Pa)
	u('pa', 'Pa', 'pascal', 'pressure', 1),
	u('kpa', 'kPa', 'kilopascal', 'pressure', 1e3),
	u('mpa', 'MPa', 'megapascal', 'pressure', 1e6),
	u('mbar', 'mbar', 'millibar', 'pressure', 100),
	u('bar', 'bar', 'bar', 'pressure', 1e5),
	u('psi', 'psi', 'pound per square inch', 'pressure', LBF / (IN * IN)),
	u('inh2o', 'inH₂O', 'inch of water', 'pressure', 249.08891),
	u('torr', 'Torr', 'torr', 'pressure', 101325 / 760),
	// temperature (K)
	u('degc', '°C', 'degree Celsius', 'temperature', 1, 273.15),
	u('degf', '°F', 'degree Fahrenheit', 'temperature', 5 / 9, 273.15 - (32 * 5) / 9),
	u('k', 'K', 'kelvin', 'temperature', 1),
	// time (s)
	u('ms', 'ms', 'millisecond', 'time', 1e-3),
	u('s', 's', 'second', 'time', 1),
	u('min', 'min', 'minute', 'time', 60),
	u('h', 'h', 'hour', 'time', 3600),
	// frequency (Hz)
	u('hz', 'Hz', 'hertz', 'frequency', 1),
	u('khz', 'kHz', 'kilohertz', 'frequency', 1e3),
	u('mhz', 'MHz', 'megahertz', 'frequency', 1e6),
	u('rpm', 'rpm', 'revolution per minute', 'frequency', 1 / 60),
	// speed (m/s)
	u('m_s', 'm/s', 'metre per second', 'speed', 1),
	u('km_h', 'km/h', 'kilometre per hour', 'speed', 1 / 3.6),
	u('ft_s', 'ft/s', 'foot per second', 'speed', 0.3048),
	u('mph', 'mph', 'mile per hour', 'speed', 0.44704),
	// flow (m³/s)
	u('l_min', 'L/min', 'litre per minute', 'flow', 1e-3 / 60),
	u('gpm', 'gpm', 'US gallon per minute', 'flow', 3.785411784e-3 / 60),
	u('scfm', 'scfm', 'standard cubic foot per minute', 'flow', 0.028316846592 / 60),
	// angle (rad)
	u('deg', '°', 'degree', 'angle', Math.PI / 180),
	u('rad', 'rad', 'radian', 'angle', 1),
	u('rev', 'rev', 'revolution', 'angle', 2 * Math.PI),
	// electrical
	u('mv', 'mV', 'millivolt', 'voltage', 1e-3),
	u('v', 'V', 'volt', 'voltage', 1),
	u('kv', 'kV', 'kilovolt', 'voltage', 1e3),
	u('ua', 'µA', 'microampere', 'current', 1e-6),
	u('ma', 'mA', 'milliampere', 'current', 1e-3),
	u('a', 'A', 'ampere', 'current', 1),
	u('mohm', 'mΩ', 'milliohm', 'resistance', 1e-3),
	u('ohm', 'Ω', 'ohm', 'resistance', 1),
	u('kohm', 'kΩ', 'kilohm', 'resistance', 1e3),
	u('megohm', 'MΩ', 'megohm', 'resistance', 1e6),
	u('pf', 'pF', 'picofarad', 'capacitance', 1e-12),
	u('nf', 'nF', 'nanofarad', 'capacitance', 1e-9),
	u('uf', 'µF', 'microfarad', 'capacitance', 1e-6),
	u('mw', 'mW', 'milliwatt', 'power', 1e-3),
	u('w', 'W', 'watt', 'power', 1),
	u('kw', 'kW', 'kilowatt', 'power', 1e3),
	u('j', 'J', 'joule', 'energy', 1),
	u('wh', 'Wh', 'watt hour', 'energy', 3600),
	u('mah', 'mAh', 'milliampere hour', 'energy', 3.6),
	// ratio and count
	u('pct', '%', 'percent', 'ratio', 1e-2),
	u('ppm', 'ppm', 'part per million', 'ratio', 1e-6),
	u('ea', 'ea', 'each', 'count', 1)
];

const BY_CODE = new Map(UNITS.map((x) => [x.code, x]));

/** The unit with this code, or undefined. */
export function unitByCode(code: string | null | undefined): Unit | undefined {
	return code ? BY_CODE.get(code) : undefined;
}

export const isUnitCode = (code: string): boolean => BY_CODE.has(code);

/** The text to show for a stored unit: the symbol of a known code, else the stored text. */
export function unitSymbol(unit: string | null | undefined): string {
	return unitByCode(unit)?.symbol ?? unit ?? '';
}

export const sameDimension = (a: string, b: string): boolean => {
	const x = unitByCode(a);
	const y = unitByCode(b);
	return !!x && !!y && x.dimension === y.dimension;
};

/** Convert a value between two units of one dimension. Throws across dimensions. */
export function convert(value: number, from: string, to: string): number {
	const a = unitByCode(from);
	const b = unitByCode(to);
	if (!a || !b) throw new Error(`Unknown unit: ${!a ? from : to}`);
	if (a.dimension !== b.dimension) throw new Error(`Cannot convert ${a.symbol} to ${b.symbol}`);
	if (a.code === b.code) return value;
	const si = value * a.factor + (a.offset ?? 0);
	return (si - (b.offset ?? 0)) / b.factor;
}

/**
 * Spellings people write in labels and old free-text units, to a code. Lower case, spaces and
 * dots removed before the lookup (see `unitFromText`).
 */
const ALIASES: Record<string, string> = {
	inch: 'in',
	inches: 'in',
	'"': 'in',
	feet: 'ft',
	foot: 'ft',
	thou: 'mil',
	micron: 'um',
	microns: 'um',
	'inlb': 'in_lbf',
	'inlbs': 'in_lbf',
	'in-lb': 'in_lbf',
	'in-lbs': 'in_lbf',
	'in-lbf': 'in_lbf',
	'inchpound': 'in_lbf',
	'inchpounds': 'in_lbf',
	'ftlb': 'ft_lbf',
	'ftlbs': 'ft_lbf',
	'ft-lb': 'ft_lbf',
	'ft-lbs': 'ft_lbf',
	'ft-lbf': 'ft_lbf',
	'footpound': 'ft_lbf',
	'footpounds': 'ft_lbf',
	'in-oz': 'in_ozf',
	'inoz': 'in_ozf',
	nm: 'n_m',
	'n-m': 'n_m',
	'n·m': 'n_m',
	ncm: 'n_cm',
	'n-cm': 'n_cm',
	lbs: 'lb',
	pound: 'lb',
	pounds: 'lb',
	ounce: 'oz',
	ounces: 'oz',
	grams: 'g',
	gram: 'g',
	degf: 'degf',
	'°f': 'degf',
	f: 'degf',
	degc: 'degc',
	'°c': 'degc',
	c: 'degc',
	degrees: 'deg',
	degree: 'deg',
	'°': 'deg',
	sec: 's',
	secs: 's',
	seconds: 's',
	minutes: 'min',
	mins: 'min',
	hours: 'h',
	hr: 'h',
	hrs: 'h',
	volts: 'v',
	amps: 'a',
	ohms: 'ohm',
	'Ω': 'ohm',
	percent: 'pct',
	'%': 'pct',
	psig: 'psi',
	psia: 'psi'
};

/** A unit code from free text ("in-lbs", "ft lbs", "psi", "°F"), or undefined. */
export function unitFromText(text: string): string | undefined {
	const t = text.trim().toLowerCase().replace(/\.$/, '');
	if (!t) return undefined;
	const compact = t.replace(/[\s.]+/g, '');
	for (const key of [t, compact, compact.replace(/-/g, '')]) {
		if (BY_CODE.has(key)) return key;
		const alias = ALIASES[key];
		if (alias) return alias;
	}
	const bySymbol = UNITS.find((x) => x.symbol.toLowerCase() === t || x.symbol.toLowerCase() === compact);
	return bySymbol?.code;
}
