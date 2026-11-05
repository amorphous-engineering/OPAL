// How large instructions and callouts read. Per browser, like the theme: it suits a screen and the
// light it is in rather than a person.
export const STEP_TEXT_SIZES = [14, 16, 18] as const;
export type StepTextSize = (typeof STEP_TEXT_SIZES)[number];

const KEY = 'opal.stepText';

function load(): StepTextSize {
	try {
		const v = Number(localStorage.getItem(KEY));
		if ((STEP_TEXT_SIZES as readonly number[]).includes(v)) return v as StepTextSize;
	} catch {
		/* storage unavailable */
	}
	return 14;
}

function apply(size: StepTextSize) {
	document.documentElement.style.setProperty('--step-text', `${size / 16}rem`);
}

export const stepText = $state<{ value: StepTextSize }>({ value: load() });
apply(stepText.value);

export function setStepText(size: StepTextSize): void {
	stepText.value = size;
	apply(size);
	try {
		localStorage.setItem(KEY, String(size));
	} catch {
		/* storage unavailable */
	}
}
