/**
 * Read a spec that people wrote inside a field label, for the SUGGEST SPEC button in the
 * template editor. Never run automatically: the author decides.
 *
 * Only explicit forms count, so free text such as "tightened 1-3 turns past hand tight" is
 * left alone: a body that starts with "spec", "approx.", "min" or "max", or has "±" between
 * two numbers. The body is in parentheses, or runs to the end of the label.
 */
import { unitFromText } from "./units.ts";
import { zSpec, type Spec } from "./specs.ts";

export interface LabelSpec {
  /** Unit code, when the label names a known unit. */
  unit?: string;
  spec?: Spec;
  /** The label with the spec text removed. */
  label: string;
}

const NUM = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
const UNIT = String.raw`\s*([^\d()±]{0,24}?)`;
const SEP = String.raw`\s*(?:-|–|—|to)\s*`;
const clean = (n: string) => n.replace(/^\+/, "");

/**
 * s without its trailing run of characters that match `ch`. A loop, because /[...]+$/
 * retries from each start of a long run that is not at the end, which is quadratic.
 */
function stripEnd(s: string, ch: RegExp): string {
  let end = s.length;
  while (end > 0 && ch.test(s[end - 1]!)) end--;
  return s.slice(0, end);
}

interface Body {
  spec: Spec;
  unitText: string;
}

/** A capture group, or '' when it did not take part (optional unit). */
const g = (m: RegExpExecArray, i: number): string => m[i] ?? "";

function parseBody(raw: string): Body | null {
  let t = raw.trim();
  const marked = /^spec(?:ification)?\b\.?:?\s*/i.test(t);
  t = t.replace(/^spec(?:ification)?\b\.?:?\s*/i, "");
  const approx = /^(?:approx\b\.?|approximately|about|~)\s*/i.test(t);
  t = t.replace(/^(?:approx\b\.?|approximately|about|~)\s*/i, "");
  t = stripEnd(t, /[\s.]/);

  let m: RegExpExecArray | null;
  if (
    (m = new RegExp(`^(${NUM})\\s*(?:±|\\+/-)\\s*(${NUM})${UNIT}$`).exec(t))
  ) {
    const tol = clean(g(m, 2)).replace(/^-/, "");
    return {
      spec: { kind: "nominal", nominal: clean(g(m, 1)), plus: tol, minus: tol },
      unitText: g(m, 3),
    };
  }
  if (marked || approx) {
    if ((m = new RegExp(`^(${NUM})${SEP}(${NUM})${UNIT}$`).exec(t)))
      return {
        spec: { kind: "range", lower: clean(g(m, 1)), upper: clean(g(m, 2)) },
        unitText: g(m, 3),
      };
    if ((m = new RegExp(`^(${NUM})${UNIT}$`).exec(t)))
      return {
        spec: { kind: "reference", nominal: clean(g(m, 1)) },
        unitText: g(m, 2),
      };
  }
  if (
    (m = new RegExp(
      `^(?:min\\b\\.?|minimum|>=|≥)\\s*(${NUM})${UNIT}$`,
      "i",
    ).exec(t))
  )
    return { spec: { kind: "min", lower: clean(g(m, 1)) }, unitText: g(m, 2) };
  if (
    (m = new RegExp(
      `^(?:max\\b\\.?|maximum|<=|≤)\\s*(${NUM})${UNIT}$`,
      "i",
    ).exec(t))
  )
    return { spec: { kind: "max", upper: clean(g(m, 1)) }, unitText: g(m, 2) };
  return null;
}

function result(
  label: string,
  from: number,
  to: number,
  body: Body,
): LabelSpec | null {
  const spec = zSpec.safeParse(body.spec);
  if (!spec.success) return null;
  const unitText = body.unitText.trim();
  const unit = unitText ? unitFromText(unitText) : undefined;
  if (unitText && !unit) return null;
  const rest = stripEnd(
    (label.slice(0, from) + " " + label.slice(to)).replace(/\s+/g, " "),
    /[\s,;:\-–—]/,
  ).trim();
  return { ...(unit ? { unit } : {}), spec: spec.data, label: rest };
}

/** The spec written in a label, or null when the label holds no explicit spec. */
export function specFromLabel(label: string): LabelSpec | null {
  for (const m of label.matchAll(/\(([^()]*)\)/g)) {
    const body = parseBody(m[1] ?? "");
    if (body) {
      const r = result(label, m.index, m.index + m[0].length, body);
      if (r) return r;
    }
  }
  const tail = new RegExp(
    `(?:^|[\\s,;])((?:spec\\b|approx\\b|approximately|min\\b|minimum|max\\b|maximum)[^()]*|${NUM}\\s*(?:±|\\+/-)[^()]*)$`,
    "i",
  ).exec(label);
  if (tail) {
    const text = tail[1] ?? "";
    const start = tail.index + tail[0].length - text.length;
    const body = parseBody(text);
    if (body) return result(label, start, label.length, body);
  }
  return null;
}
