# android-cam-tui — Design

Terminal UI for using an Android phone as a Linux webcam via scrcpy. Webcam-first
scope: camera streaming to a v4l2loopback sink only — no screen mirroring,
recording, or input control.

## Stack

- Bun + TypeScript + `@opentui/react`.
- Single process. The TUI spawns `scrcpy` as a child (`Bun.spawn`), reads its
  stderr for state, and owns the auto-restart loop.
- No daemon, no IPC. Quitting the TUI stops the stream.

Rejected alternative: TUI + detached daemon so streams outlive the UI. More
plumbing (process handoff, state reconciliation) for a flow the user didn't
choose; the dashboard model was picked explicitly.

## Screens

### Setup

- Device panel: adb connection state, phone model.
- Option form, populated live by probing the device (never hardcoded):
  - Camera picker — from `scrcpy --list-cameras` (id, facing, max size, fps
    sets, zoom range).
  - Lens/zoom — free value within the camera's zoom range, with snap presets
    at 0.6 (ultrawide) / 1 (main) / 3 (tele).
  - Resolution — from `scrcpy --list-camera-sizes` for the selected camera.
  - FPS — from the camera's advertised fps set.
  - Bitrate — free entry, default 16M (raise for 2K+).
  - Sink device — detected v4l2loopback devices, default the one labeled
    "Phone Cam".
- Command preview line: the exact scrcpy invocation the current form builds.
- Enter starts the stream and switches to Dashboard.

### Dashboard

- Status: running / restarting / dead, uptime, drop counter.
- Event log: last 10 classified events (camera evicted, device disconnected,
  restart, phone locked).
- Hotkeys: `z` cycle zoom presets (within current camera), `l` cycle camera id
  (back logical / front), `r` force restart, `s` stop and return to Setup,
  `q` quit.
- Any option change restarts scrcpy under the hood (~3 s). The v4l2 sink stays
  open across restarts, so consuming apps see a frozen frame, not a lost
  device.

## scrcpy integration

- **Probe layer**: runs the list commands, parses output into a typed model
  (camera id, facing, sizes, fps sets, zoom range). Parsers are pure functions
  of captured text.
- **Runner**: builds the flag array from config, spawns scrcpy, classifies
  stderr lines (`Camera disconnected`, `Device disconnected`, capture-failed
  spam) into events, auto-restarts with a 2 s backoff.
- **Phone prep** on every start: `input keyevent KEYCODE_WAKEUP` +
  `wm dismiss-keyguard`. Root cause from field debugging: Samsung's
  CameraService evicts adb-shell camera clients the moment the keyguard
  engages, and on any phone-side camera use (face unlock, camera app). The
  restart loop is the durable fix; unlocking at start prevents the common
  case.
- **v4l2loopback check**: if no loopback sink exists, warn and offer one-key
  `sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"`.

## Persistence and errors

- Last-used config saved to `~/.config/android-cam-tui/config.json`, loaded as
  form defaults. No named profiles until someone asks.
- No adb device → Setup shows the USB-debugging steps.
- No scrcpy binary → install hint.
- Camera busy / phone locked → event log says "unlock phone", runner keeps
  retrying on backoff.

## Testing

- Parsers: unit tests against captured real scrcpy output (S23 transcripts,
  4 camera IDs including logical camera and high-speed modes).
- Runner: integration test against a fake scrcpy shell script that emits the
  known death lines and exit codes.
- UI: manual smoke test.
