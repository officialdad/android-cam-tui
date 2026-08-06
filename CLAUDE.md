# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun start                      # run the TUI (src/index.tsx)
bun run demo                   # setup screen against fixture cameras — no phone needed
bun run typecheck              # tsc --noEmit
bun test                       # all tests
bun test tests/runner.test.ts  # one file
bun test -t "auto-restarts"    # one test by name substring
bun run src/index.tsx --doctor   # dependency report, no TUI
```

Runtime deps outside the repo: `scrcpy` ≥ 3.0, `adb`, `v4l2-ctl` on PATH, and a
v4l2loopback sink (`sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"`).
The phone must be unlocked — Android evicts adb camera clients when the keyguard engages.

## Architecture

React renders to the terminal via `@opentui/react` (`jsxImportSource` in tsconfig).
Intrinsic elements are `<box>`, `<text>`, `<span>`, `<select>`, `<scrollbox>` — not DOM.
There is no test framework beyond `bun:test`; UI tests use `@opentui/react/test-utils`
`testRender` + `mockInput`.

`src/app.tsx` owns the two-screen state machine (`setup` → `dashboard`) and is the only
place `StreamRunner` is constructed. The runner lives in a ref, not state, because it
mutates its own `state`/`startedAt`; a `bump` counter forces the re-render instead.

### Everything is a subprocess

No library talks to the phone — `scrcpy`, `adb` and `v4l2-ctl` are spawned with
`Bun.spawn` and their stdout/stderr parsed. Each module splits a **pure parser** from
its **spawn wrapper**, and that split is the entire testing seam:

| pure | spawner | file |
|---|---|---|
| `parseCameras`, `parseSinks` | `probeCameras`, `probeSinks` | `src/scrcpy/probe.ts` |
| `parseDevices` | `listDevices`, `goWireless`, `goUsb` | `src/scrcpy/devices.ts` |
| `buildArgs` | — | `src/config.ts` |
| `checks`, `detectDistro`, `parseScrcpyVersion` | `probeEnv` | `src/doctor.ts` |

Parsers are tested against text fixtures in `tests/fixtures/`. `StreamRunner` takes
`scrcpyPath`/`adbPath` options so tests inject shell-script fakes (`fake-scrcpy.sh`,
`slow-adb.sh`, or one written to a tmpdir). Keep new shell-outs to this shape: parse
function first, spawn wrapper around it.

`src/doctor.ts` is the preflight. `probeEnv()` gathers binaries (`Bun.which`),
the scrcpy version, sinks, devices and `/etc/os-release` without ever rejecting;
`checks()` turns that into `block`/`warn` entries carrying the install commands
for the detected distro. `Setup` renders `<Doctor>` instead of the setup screen
when a `block` check fails. The doctor never runs a privileged command — new
checks print a command, they do not execute one.

`Bun.spawn` throws **synchronously** when the executable is missing, so every
spawn wrapper needs a try around the spawn itself, not just around the await.

`adb`'s `-s <serial>` must precede the subcommand (`adb -s X shell ...`), and every
scrcpy/adb call is serial-scoped so a USB and a wireless device can be attached at once.

### StreamRunner epochs

`src/scrcpy/runner.ts` supervises the stream and auto-restarts when Android kills the
camera. It has multiple `await` points (`prepPhone`, restart delay) during which
`stop()` or a newer `start()` may land. A monotonic `epoch` counter is the abort
mechanism: capture `myEpoch` before an await, **re-check after every one**, bail if it
moved. `stop()` bumps the epoch. Adding an await inside `start`/`onExit` without an
epoch re-check reintroduces the double-spawn and stale-restart bugs the tests cover.

### Keyboard: `useKeyboard` is global

Every mounted component's `useKeyboard` handler receives every key. Consequences that
run through the whole UI:

- Widgets must guard on their own `focused` prop first, or several react to one key.
- While `FilteredSelect` captures a `/` query it reports up via `onCaptureChange`, and
  `Setup` holds that in a `capturing` ref to stop the parent from stealing keystrokes.
- **State mirrored into refs is deliberate.** Keys arrive faster than React re-renders
  (key repeat, paste, multi-byte reads), so handler closures read stale state:
  `filteringRef` in `FilteredSelect`, `idxRef` in `Stepper`, `capturing` in `Setup`.
  Removing a ref in favour of the state it mirrors looks like a cleanup and is a bug.

### Config reconciliation

`StreamConfig` (`src/config.ts`) is persisted to `~/.config/android-cam-tui/config.json`
and can name a camera, size or fps the current phone does not have — after a device
switch it usually does. `reconcile()` in `src/ui/setup.tsx` is the single place a config
is snapped onto probed capabilities; any change to device, camera or size must route
through it rather than doing a partial `setConfig`.

`fps` and `highSpeed` are one coupled choice, not two fields. High-speed rates (120/240)
come from a separate camera capture session, are listed **per size** rather than per
camera, and need `--camera-high-speed`. `fpsStops(cam, size)` produces the combined list;
never let the two values be set independently.
