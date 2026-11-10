# Launch Control

Launch Control is a separate app for amateur sounding-rocket launches. The launch director runs the count on it. The count never waits on OPAL. OPAL keeps the record of the flight: the execution, the signatures, the motor lot, the dataset and the issues.

Launch Control shows telemetry and does the launch control. It does not show or complete procedure steps. The crew completes the steps in OPAL. Launch Control shows one read-only line: the work order, the procedure, the current step and an OPEN IN OPAL link. It reads the step state for the ARM interlock. It writes the count journal as execution comments, the telemetry frames into the dataset and the motor lot consumed at fire. It does this through the plugin.

The app is in `app/`. It is SvelteKit with vendored shadcn-svelte. The OPAL plugin is a concept. It has no code. `DESIGN.md` has the architecture, the fail-safe rules and the human-factors basis.

## Run the app in dev

1. Start OPAL on :8080 with a temporary data folder. Without OPAL, the app still runs on the simulator.
2. Run `pnpm --filter @opal/launch-control dev`.
3. Open http://localhost:5174.

The dev server proxies `/plugins/launch-control` to OPAL on :8080. The simulator drives the count when no pad hardware is present.

## Status

The app is a prototype. It has no pad hardware and no tested hardware interlock. It is not an approval for live use. See section 7 of `DESIGN.md`.
