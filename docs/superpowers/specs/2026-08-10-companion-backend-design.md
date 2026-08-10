# Companion backend for phones scrcpy cannot serve

`scrcpy --video-source=camera` drives the camera as the shell uid, and upstream gates
that at Android 12. On vendor builds that revoke `CAMERA` from `com.android.shell`
outright, no scrcpy flag helps at any API level — the refusal happens on permissions,
before capture starts.

The `android-cam` repo solves that with a companion APK: a foreground service holding
its own user-granted `CAMERA` permission, encoding Camera2 output to H.264 and writing
Annex-B to an abstract unix socket. This spec wires that APK into `android-cam-tui` as a
second stream backend, replacing the hard `MIN_SDK` block added in `43be246`.

```
scrcpy backend    scrcpy --video-source=camera ─────────────▶ /dev/videoN
companion backend Camera2 ▶ MediaCodec ▶ localabstract ──▶ ffmpeg ▶ /dev/videoN
                                          ▲ adb forward
```

## Scope

In: backend selection, the companion launch path, doctor checks for its prerequisites,
setup and dashboard adjustments, APK vendoring.

Out: **the revoked-`CAMERA` ROM case above.** It motivates the APK, not the routing.
Backend selection below is automatic and reads the API level only, so a modern phone on
one of those ROMs still gets sent down the scrcpy path and still fails — there is no
signal to detect it with short of attempting a capture, and no user-facing override to
force the companion path by hand. Serving it means a manual backend choice or a probe
failure fallback; neither is built here. Do not go looking for that routing.

Out: any change to the APK itself. Camera, resolution, fps and bitrate stay hardcoded at
back camera / 1280x720 / 30 / 8M because the APK has no control channel. Adding one is a
separate project in the `android-cam` repo.

## Backend selection

`StreamConfig` gains:

```ts
backend: "scrcpy" | "companion"
```

It is **never read from the config file**. `loadConfig` merges over `DEFAULT_CONFIG`
as it does today, but `reconcile()` overwrites the field unconditionally from the
selected device's `sdk`: below `MIN_SDK` (31) is `companion`, otherwise `scrcpy`. An
undefined `sdk` — a device not reachable enough to answer `getprop` — stays `scrcpy`,
matching the existing rule that only a phone that provably answered below the floor is
treated as too old.

This keeps `reconcile()` as the single place a config is snapped onto probed
capabilities, and means there is no way for a stale config file to point a modern phone
at the companion path or the reverse. No new setup field, no user-facing choice.

`reconcile()` gains a `sdk: number | undefined` parameter. Its four call sites in
`setup.tsx` all already have the `DeviceInfo` in hand.

## Companion capabilities are constant, not probed

`probeCameras` shells out to `scrcpy --list-camera-sizes`. For a phone on the companion
path that is at best useless — the APK ignores everything it would report — and at worst
it is the exact failure being worked around, since a ROM that revokes `CAMERA` from
`com.android.shell` fails the listing too. Today that produces the synthetic
`no cameras on <serial>` blocker, which would fire on precisely the devices this feature
exists to serve.

So the companion path skips the probe entirely and substitutes a constant that describes
what the APK actually does:

```ts
export const COMPANION_CAM: CameraInfo = {
  id: "0",
  facing: "back",
  maxSize: "1280x720",
  fps: [30],
  zoomRange: null,
  sizes: ["1280x720"],
  highSpeed: {},
}
```

Every existing widget then works unmodified against a one-camera, one-size, one-rate
list, and `reconcile()` snaps any saved config onto it by the rules it already has.

Both places that call `getCameras` — `preflight()` and `selectDevice()` — branch on the
selected device's `sdk` and use `[COMPANION_CAM]` instead of awaiting the probe.

## `src/companion.ts`

One new module, following the pure-parser / spawn-wrapper split that `probe.ts` and
`devices.ts` use, because that split is the whole testing seam in this codebase.

| pure | spawner |
|---|---|
| `parseCompanionState(dumpsys: string): CompanionState` | `companionState(serial, adbPath?)` |
| `socketReady(procNetUnix: string): boolean` | `prepPhone(serial, adbPath?)` |
| `ffmpegArgs(port: number, sink: string): string[]` | — |

```ts
export const PKG = "com.officialdad.androidcam"
export const SOCKET = "android-cam"
export const PORT = 27183
export interface CompanionState { installed: boolean; granted: boolean }
```

`parseCompanionState` reads one `adb shell dumpsys package com.officialdad.androidcam`.
Empty or `Unable to find package` means not installed; the presence of
`android.permission.CAMERA: granted=true` means granted. One round-trip answers both
questions, so there is no second adb call.

`socketReady` tests the output of `adb shell cat /proc/net/unix` for `@android-cam`.
Abstract sockets are listed there with a leading `@`, which is how `run.sh` waits.

`prepPhone(serial)`:

1. `adb -s <serial> forward tcp:27183 localabstract:android-cam` — idempotent, so it is
   re-run on every spawn rather than tracked and torn down.
2. `adb -s <serial> shell am start-foreground-service -n <PKG>/.CamService`.
   **Never `am start` an activity.** Waking a locked phone starts face unlock, which
   opens a camera of its own and pushes the device past the system-wide open-camera
   limit, so our own open is then rejected — the same trap that produced the restart loop
   fixed in `8efa939`.
3. Poll `socketReady` up to 30 times at 200 ms. The service binds its socket a beat after
   the process starts; racing ffmpeg against it fails.

It throws on timeout with the diagnosis `run.sh` prints — the permission is the usual
cause.

`ffmpegArgs(port, sink)` reproduces `run.sh`'s invocation exactly:

```
-hide_banner -loglevel warning -fflags nobuffer -flags low_delay -r 30
-f h264 -i tcp://127.0.0.1:<port> -fps_mode passthrough
-vf format=yuv420p -f v4l2 <sink>
```

The `-r 30` before `-i` is load-bearing and must not be moved or dropped: Annex-B carries
no timestamps, so ffmpeg otherwise guesses a 1200k tbr and drops ~98% of the frames
converting down to it.

Teardown needs nothing. The APK opens the camera when a client connects and releases it
on disconnect, then loops back to `accept()`, so killing ffmpeg is a complete stop. No
`am force-stop`, no `adb forward --remove`.

## APK vendoring

`android-cam.apk` is 13 KB and is copied to `src/android-cam.apk`, imported as an
embedded file so it survives `bun build --compile`:

```ts
import apk from "./android-cam.apk" with { type: "file" }
```

That yields a path readable through `Bun.file` in both the dev checkout and the compiled
binary — but **not** a path `adb` can open, because in the compiled binary it addresses
Bun's embedded filesystem. `adb install` is a subprocess and needs a real one.

So `materializeApk()` writes the bytes to `~/.cache/android-cam-tui/android-cam.apk` and
returns that path. `checks()` is pure and stays that way, so the write happens in
`probeEnv()` — the spawn side — and only when a device below `MIN_SDK` is attached. It
lands on `Env` as `apkPath: string | null`, which is what the `companion-apk` fix line
names. Like everything else in `probeEnv`, it never rejects: a failed write leaves
`apkPath` null and the fix line falls back to naming the repo's own `android-cam.apk`.

This does not breach the doctor's print-only rule. Writing 13 KB into the user's cache
directory is not running a command on their behalf.

`files` in `package.json` already covers `src`, and PKGBUILD ships the compiled binary,
so packaging needs no change beyond the copy.

## StreamRunner

The command becomes a function of the backend:

```ts
this.config.backend === "companion"
  ? ["ffmpeg", ...ffmpegArgs(PORT, this.config.sink)]
  : [this.scrcpyPath, ...buildArgs(this.config)]
```

`buildArgs` is untouched; it stays the scrcpy-only builder it is today.

`spawn()` becomes `async` because the companion path needs three adb round-trips before
ffmpeg exists. Per the epoch discipline, it captures `myEpoch` at the top and re-checks
after the prep await, before `Bun.spawn`. Both callers already handle this correctly:
`start()` awaits it, and `onExit()` re-checks its own epoch before calling it.

Prep failure does **not** propagate as a rejection. It records the message as
`lastError` and routes into the existing `onExit` path, so a phone that is not answering
yet gets the same backoff, attempt budget and `gave-up` event as one that died mid-stream
— a phone still booting is exactly the case retries are for.

`live.add(this)` stays where it is, synchronously before the await, so a `stop()` landing
mid-prep finds the runner registered and its epoch bump aborts the spawn before any
process exists.

`watch()` currently matches scrcpy's `Camera disconnected` and `Device disconnected`
strings. ffmpeg prints neither, so on the companion path those events simply never fire
and a death surfaces as `exited` with ffmpeg's last stderr line. That is honest and
needs no new parsing; `runner.ts` continues to spawn bare because a `block` check has
already proved ffmpeg is on PATH.

## Doctor

`device-android` stops blocking: an old phone is now serviceable. The check is removed
rather than inverted, and three replace it, all gated on `needsCompanion` and all
print-only.

`needsCompanion` follows the mutual-exclusion pattern the existing device checks use: an
old phone is present in state `device` **and** no scrcpy-capable phone is. One working
modern handset satisfies everything, so a second old one never blocks a working session.

| id | detail | fix |
|---|---|---|
| `ffmpeg` | `ffmpeg is not on PATH — the companion backend pipes through it` | `pkg.ffmpeg` |
| `companion-apk` | `Android Cam is not installed on <serial>` | `adb install -r -g <cache path>` |
| `companion-perm` | `Android Cam has no CAMERA permission on <serial>` | `adb shell pm grant …`, plus the Settings path for ROMs that refuse `-g` |

`PKGS` gains an `ffmpeg` entry per distro (`ffmpeg` on all four; the `unknown` entry gets
a comment line as its siblings do).

`Env` gains `ffmpeg: string | null` from `Bun.which`. `DeviceInfo` gains
`companion?: CompanionState`, filled by `listDevices` with one extra round-trip for
devices below `MIN_SDK` only — the same conditional shape as the existing `sdk` lookup,
so a modern-phone-only setup pays nothing.

Both fix lines stay under 76 columns and are shell-valid, which `tests/doctor.test.ts`
already enforces across every distro.

## Setup screen

`OUTPUT_FIELDS` shrinks to `["sink"]` on the companion path: bitrate, zoom, rotate and
buffer are all scrcpy flags, and the APK has no control channel to honour them. Showing
steppers that silently do nothing is worse than not showing them.

The `scrcpy <args>` preview line at the bottom shows the ffmpeg command instead, so what
is displayed is always what will run. A `companion backend — 1280x720@30 fixed` line
states the ceiling plainly.

`deviceLabel`'s `Android <12` suffix stays. It is now informative rather than a warning,
and remains the only signal distinguishing the two devices in the picker.

## Dashboard

`z` (zoom cycle) and `t` (torch) no-op on the companion path — no control channel. `c`
(camera cycle) already no-ops on a one-camera list. `p` (preview) and `r` (restart) work
unchanged, since both operate on the sink and the runner rather than on scrcpy.

The header names the active backend, so a user looking at a stream knows which path
produced it.

## Testing

Follows the existing shape: parsers against fixtures in `tests/fixtures/`, spawners
exercised through injected fakes.

- `parseCompanionState` against three fixtures — installed and granted, installed and
  ungranted, absent.
- `socketReady` against a real `/proc/net/unix` capture, with and without the entry.
- `ffmpegArgs` asserts `-r 30` precedes `-i`, since that ordering is the difference
  between 30 fps and 0.5 fps and nothing else would catch a reorder.
- `reconcile` picks `companion` below `MIN_SDK`, `scrcpy` at or above, and `scrcpy` for
  an undefined `sdk`; a config file naming the wrong backend is overridden.
- `checks()` over the old-phone matrix: old phone alone with nothing installed produces
  all three blocks; old phone alongside a modern one produces none; a modern phone alone
  produces no companion checks. The existing 76-column and shell-validity assertions
  cover the new fix lines automatically.
- Runner: `stop()` during prep never spawns ffmpeg, and a prep failure produces `exited`
  followed by `restarting` rather than an unhandled rejection.

## Deliberate ceilings

- **scrcpy stays a hard block even for a companion-only user.** Making it conditional
  means threading device state through a check that currently only asks whether a binary
  exists. Revisit if someone reports it.
- **No zoom, torch, resolution or bitrate on the companion path** until the APK grows a
  control channel. The `ponytail:` comment on those constants in `CamService.java`
  already marks it.
- **Latency is unmeasured** against scrcpy's camera path. The extra hop is one localhost
  TCP forward and an ffmpeg remux, so it should be small, but no number has been taken.
