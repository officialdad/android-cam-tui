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

Runtime deps outside the repo: `scrcpy` ≥ 3.0, `adb`, `v4l2-ctl`, `ffmpeg` (companion
backend only) on PATH, and a v4l2loopback sink (`sudo modprobe v4l2loopback
exclusive_caps=1 card_label="Phone Cam"`). The phone does **not** need unlocking on
either backend: `--list-cameras` and camera capture both work through the keyguard
with the screen off, and `am start-foreground-service` leaves a locked phone locked
too. Never wake or unlock it from code — waking a locked phone starts face unlock,
which opens a camera of its own and pushes the device over the system-wide
open-camera limit, so scrcpy's own open is rejected. That is what
`StreamRunner.prepPhone()` used to do, and it turned every restart into a restart loop.

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
| `checks`, `detectDistro`, `parseScrcpyVersion`, `parseScrcpyFlags` | `probeEnv`, `probeScrcpyFlags` | `src/doctor.ts` |
| `parseCompanionState`, `socketReady` | `companionState`, `prepPhone`, `unforward` | `src/companion.ts` |
| `ffmpegArgs` | — | `src/companion.ts` |

Parsers are tested against text fixtures in `tests/fixtures/`. **Every fixture is a
verbatim capture from the real tool** — `scrcpy … > tests/fixtures/x.txt 2>&1`, never text
transcribed from a doc or a plan. The camera fixture was hand-written from the design plan
using an `fps={…}` syntax no scrcpy has ever printed, so `parseCameras` matched the fixture
and zero real phones, and the suite stayed green through every release. A parser fixture
that was never captured tests only itself. `StreamRunner` takes a
`scrcpyPath` option so tests inject shell-script fakes (`fake-scrcpy.sh`, or one
written to a tmpdir). Keep new shell-outs to this shape: parse
function first, spawn wrapper around it.

`src/doctor.ts` is the preflight. `probeEnv()` gathers binaries (`Bun.which`),
the scrcpy version, sinks, devices and `/etc/os-release` without ever rejecting;
`checks()` turns that into `block`/`warn` entries carrying the install commands
for the detected distro. `Setup` renders `<Doctor>` instead of the setup screen
when a `block` check fails. The doctor never runs a privileged command — new
checks print a command, they do not execute one.

`checkList` in `src/ui/setup.tsx` is the only source of user-facing dependency
truth. A failure `checks()` cannot see (no cameras, a thrown preflight) is pushed
onto it as a synthetic `block` entry so it renders through `<Doctor>` and inherits
the warnings and the `r` key. Do not add a second error box.

Two rules bind every `fix` line, both because the user pastes it into a shell:

- **76 columns.** The doctor indents fix lines by two inside a bordered, padded
  box, so anything longer wraps at 80 and the paste is a broken command.
- **Shell-valid.** `c` copies `fixScript()` — the failing checks, details as
  comments — to the clipboard, so a prose line must carry its own `#`. Without
  it the paste tries to run "plug the phone in over USB". `tests/doctor.test.ts`
  enforces both across every distro.

`Bun.spawn` throws **synchronously** when the executable is missing, so a new
spawn wrapper wants its try around the spawn itself, not just around the await —
that is what `probe.ts` and `devices.ts` do. `runner.ts` and `preview.ts` still
spawn bare; both are only reachable once something else has proved the binary is
there (a `block` check, `Bun.which`), so keep that guarantee if you move them.

scrcpy's camera flags arrive release by release, and an unrecognized option makes scrcpy
exit *before* it opens the camera — which `StreamRunner` can only read as a dead stream and
retry until it gives up. `parseScrcpyFlags` reads the long options out of `scrcpy --help`,
and `buildArgs(config, flags)` drops the ones in `OPTIONAL_FLAGS` that this build lacks.
`--camera-torch` and `--camera-zoom` are documented on upstream master and ship in no
released scrcpy (3.3.4 included), so both are gated today. Everything outside
`OPTIONAL_FLAGS` is emitted unconditionally, so a mis-parsed help text can never strip the
stream's essentials. Add a flag to that list only when scrcpy grew it after 3.0.

`adb`'s `-s <serial>` must precede the subcommand (`adb -s X shell ...`), and every
scrcpy/adb call is serial-scoped so a USB and a wireless device can be attached at once.

### Two backends

`StreamConfig.backend` is derived from the phone's API level by `backendFor()` in
`src/doctor.ts` and never read from the saved config — a config outlives the phone
it was written for. Below `MIN_SDK` (31) `StreamRunner` preps the phone over adb
instead of spawning scrcpy: `prepPhone()` forwards a port, starts `CamService` with
`am start-foreground-service`, and polls `/proc/net/unix` for its socket before
`ffmpeg` pipes the H.264 into the sink. The APK's capabilities are the
`COMPANION_CAM` constant rather than a probe result — probing is the very thing
that fails on these phones, and the APK has no control channel to honour the answer
anyway. The `-r 30` before `-i` in `ffmpegArgs` is load-bearing: Annex-B carries no
timestamps, so without it ffmpeg guesses the input rate and drops most frames
converting down.

`COMPANION_MIN_SDK` (26) is the floor under that floor: `am start-foreground-service`
arrived in Android 8.0, so below it the APK installs and then never starts. The
companion checks are **not** mutually exclusive with a usable modern handset the way
`device-perms` and `device-auth` are — the backend is picked per selected device, so
they warn when another phone works and block when none does. `stop()` removes the
`adb forward`: it lives in the adb server and outlives the TUI, and anything that
connects to that port makes the phone open its camera.

The APK (source in the separate `android-cam` repo, `0fca43c`) answers a probe over
`adb shell dumpsys activity service …/.CamService` — its `dump()` prints one JSON
line with real cameras: id, facing, `SENSOR_ORIENTATION`, max digital zoom, minimum
focus distance, encoder sizes, AE fps ranges. `parseCompanionProbe`/`probeCompanionCams` in `src/companion.ts`
turn that into `CameraInfo[]`; the probe starts the service itself (idempotent, no
extras) and needs no CAMERA grant. `COMPANION_CAM` is only the fallback for an APK
too old to answer. Probed fps options are the AE upper bounds — rates the service
honours exactly, which is what keeps ffmpeg's `-r` (which must match the actual
stream rate) honest; the fallback keeps fps locked to its single stop for the same
reason. Sensor orientation pre-selects the rotate option via `suggestedRotation()`,
applied only when the camera changes — never over a user's pick.

Size, bitrate, zoom, focus, torch and camera ride the start intent
(`--ei`/`--ef`/`--es` in `serviceExtras()`); the service clamps to what the camera
offers, and the socket stays pure H.264 — its client is ffmpeg, which can neither
send a config frame nor tolerate a reply. Zoom, focus and torch are always sent — a
re-run `am` keeps absent extras at their previous values, so "auto" must be an
explicit 100, autofocus an explicit -1, torch-off an explicit 0. Focus is a fixed
distance in diopters (0 = infinity), bounded by the probed
`LENS_INFO_MINIMUM_FOCUS_DISTANCE` (`CameraInfo.minFocus`; absent = fixed-focus
lens, autofocus is the only stop) and clamped by the phone. Torch is the one extra
the service applies mid-stream, which is why the dashboard's `t` on companion goes
through `sendExtras()` (a bare re-run of the start intent) instead of a restart.
Rotation and aspect are the other direction: ffmpeg `-vf` filters in `ffmpegArgs()`
(Annex-B has no rotation metadata; phone-side rotation would need a GL pass), so
they work with any APK. The scrcpy path crops too (`cropFor()` in `config.ts` →
`--crop`), with the same crop-before-orientation order on both backends — one menu,
one meaning per field; the v4l2 buffer stays scrcpy-only and focus companion-only
(`fieldsFor()`). Old APK + new host: extras ignored, no probe answer, defaults
stream. New APK + old host: no extras, defaults stream. A rebuilt APK updates
`src/android-cam.apk` and the sha256 comment in `src/companion.ts`.

### StreamRunner epochs

`src/scrcpy/runner.ts` supervises the stream and auto-restarts when Android kills the
camera. It `await`s the restart backoff, during which
`stop()` or a newer `start()` may land. A monotonic `epoch` counter is the abort
mechanism: capture `myEpoch` before an await, **re-check after every one**, bail if it
moved. `stop()` bumps the epoch. Adding an await inside `start`/`onExit` without an
epoch re-check reintroduces the double-spawn and stale-restart bugs the tests cover.

`spawn()` follows the same rule for the companion path: it captures `myEpoch` before
awaiting `prepPhone()` and re-checks after it. A prep failure does not reject
`start()` — it routes into `onExit()` instead, so it inherits the same backoff as a
mid-stream death rather than surfacing as an unhandled rejection.

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
