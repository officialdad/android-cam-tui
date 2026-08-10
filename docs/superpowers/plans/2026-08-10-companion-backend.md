# Companion APK Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream from phones running Android below 12 by driving the `android-cam` companion APK, replacing the hard block added in `43be246`.

**Architecture:** A second backend selected automatically from the phone's API level. `scrcpy` stays exactly as it is; below API 31 the runner instead prepares the phone over adb (forward, start foreground service, wait for its socket) and spawns `ffmpeg` to pipe the H.264 stream into the same v4l2 sink. The APK's capabilities are constants, not a probe result, because the APK has no control channel and because probing is what fails on these devices.

**Tech Stack:** Bun, TypeScript, React via `@opentui/react`, `bun:test`. All phone interaction is `Bun.spawn` over `adb`/`ffmpeg`/`scrcpy` with parsed stdout.

**Spec:** `docs/superpowers/specs/2026-08-10-companion-backend-design.md`

## Global Constraints

- **Every module splits a pure parser from its spawn wrapper.** That split is the only testing seam in this codebase. Parsers are tested against text fixtures in `tests/fixtures/`; spawners are tested through injected fake binaries.
- **`Bun.spawn` throws synchronously** when the executable is missing. A new spawn wrapper puts its `try` around the spawn itself, not just the await.
- **`adb`'s `-s <serial>` precedes the subcommand**: `adb -s X shell ...`, never `adb shell -s X`.
- **Never wake or unlock the phone.** No `am start` of an activity, no `input keyevent`, no `--stay-awake` equivalent on the companion path. Waking a locked phone starts face unlock, which opens a camera of its own and pushes the device past the system-wide open-camera limit, so our own open is then rejected.
- **Doctor fix lines: 76 columns maximum**, and every line is either a runnable command or carries its own leading `#`. `tests/doctor.test.ts` enforces both across all five distros. The only existing exemption is the RPM Fusion URL.
- **The doctor never runs a command on the user's behalf.** It prints. Writing a 13 KB cache file is not running a command.
- **`reconcile()` in `src/ui/setup.tsx` is the single place a config is snapped onto probed capabilities.** Any change to device, camera, size or backend routes through it.
- **StreamRunner epochs:** capture `myEpoch` before an await and re-check after *every* one, bailing if it moved. `stop()` bumps the epoch. An await added without a re-check reintroduces the double-spawn bug.
- **State mirrored into refs in the UI is deliberate** (`filteringRef`, `idxRef`, `capturing`). Keys arrive faster than React re-renders. Do not "clean up" a ref into the state it mirrors.
- Package identifiers, fixed verbatim: package `com.officialdad.androidcam`, service `.CamService`, abstract socket `android-cam`, port `27183`, capture `1280x720` at `30` fps.
- `MIN_SDK` is 31 (Android 12) and stays the single numeric floor.

---

## File Structure

**Created:**
- `src/companion.ts` — everything about the companion backend: constants, the three pure parsers, the three spawn wrappers, the APK path. One file rather than a directory, because it is ~120 lines and every part of it changes together.
- `src/apk.d.ts` — module declaration so TypeScript accepts the binary import.
- `src/android-cam.apk` — the vendored APK, copied from `~/repo/android-cam/android-cam.apk`.
- `tests/companion.test.ts`
- `tests/fixtures/dumpsys-granted.txt`, `dumpsys-ungranted.txt`, `dumpsys-absent.txt`, `proc-net-unix-ready.txt`, `proc-net-unix-cold.txt`

**Modified:**
- `src/config.ts` — `backend` field on `StreamConfig` and `DEFAULT_CONFIG`.
- `src/doctor.ts` — `backendFor()`, `Env.ffmpeg`, `Env.apkPath`, companion probing in `probeEnv()`, `device-android` replaced by three checks, `PKGS.ffmpeg`.
- `src/scrcpy/devices.ts` — export `adb()`, add `DeviceInfo.companion`.
- `src/scrcpy/runner.ts` — backend-dependent command, `spawn()` becomes async with an epoch re-check, prep failure routed into `onExit`.
- `src/ui/setup.tsx` — `reconcile()` takes `sdk`, companion path skips the probe, field list and command preview shrink.
- `src/ui/dashboard.tsx` — backend shown, `z`/`t` inert on the companion path.
- `src/app.tsx` — `--start` re-derives the backend; camera list is a constant on the companion path.
- `README.md`, `CLAUDE.md`, `tests/doctor.test.ts`, `tests/setup.test.ts`, `tests/setup-render.test.tsx`.

---

## Task 1: Companion constants and pure parsers

**Files:**
- Create: `src/companion.ts`
- Create: `tests/companion.test.ts`
- Create: `tests/fixtures/dumpsys-granted.txt`, `tests/fixtures/dumpsys-ungranted.txt`, `tests/fixtures/dumpsys-absent.txt`, `tests/fixtures/proc-net-unix-ready.txt`, `tests/fixtures/proc-net-unix-cold.txt`

**Interfaces:**
- Consumes: `CameraInfo` from `src/scrcpy/probe.ts` (type only).
- Produces: `PKG`, `SOCKET`, `PORT`, `COMPANION_CAM`, `CompanionState`, `parseCompanionState(dumpsys: string): CompanionState`, `socketReady(procNetUnix: string): boolean`, `ffmpegArgs(port: number, sink: string): string[]`.

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/dumpsys-granted.txt`:

```
Activity Resolver Table:
  Non-Data Actions:

Packages:
  Package [com.officialdad.androidcam] (5f3a1c2):
    userId=10247
    pkg=Package{5f3a1c2 com.officialdad.androidcam}
    codePath=/data/app/com.officialdad.androidcam-1
    versionCode=0 minSdk=21 targetSdk=32
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    requested permissions:
      android.permission.CAMERA
      android.permission.FOREGROUND_SERVICE
    install permissions:
      android.permission.FOREGROUND_SERVICE: granted=true
    User 0: ceDataInode=1441802 installed=true hidden=false
      runtime permissions:
        android.permission.CAMERA: granted=true, flags=[ USER_SET ]
```

`tests/fixtures/dumpsys-ungranted.txt`:

```
Packages:
  Package [com.officialdad.androidcam] (5f3a1c2):
    userId=10247
    versionCode=0 minSdk=21 targetSdk=32
    requested permissions:
      android.permission.CAMERA
    install permissions:
      android.permission.FOREGROUND_SERVICE: granted=true
    User 0: ceDataInode=1441802 installed=true hidden=false
      runtime permissions:
        android.permission.CAMERA: granted=false, flags=[ ]
```

`tests/fixtures/dumpsys-absent.txt`:

```
Unable to find package: com.officialdad.androidcam
```

`tests/fixtures/proc-net-unix-ready.txt` (abstract sockets carry a leading `@`):

```
Num       RefCount Protocol Flags    Type St Inode Path
ffff8a1c: 00000002 00000000 00010000 0001 01 21983 /dev/socket/logdw
ffff8a2d: 00000002 00000000 00010000 0001 01 22104 @android-cam
ffff8a3e: 00000003 00000000 00000000 0001 03 22110 /dev/socket/property_service
```

`tests/fixtures/proc-net-unix-cold.txt`:

```
Num       RefCount Protocol Flags    Type St Inode Path
ffff8a1c: 00000002 00000000 00010000 0001 01 21983 /dev/socket/logdw
ffff8a3e: 00000003 00000000 00000000 0001 03 22110 /dev/socket/property_service
```

- [ ] **Step 2: Write the failing tests**

Create `tests/companion.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { COMPANION_CAM, ffmpegArgs, parseCompanionState, socketReady } from "../src/companion"

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text()

describe("parseCompanionState", () => {
  test("reads installed and granted from one dumpsys", async () => {
    expect(parseCompanionState(await fixture("dumpsys-granted.txt"))).toEqual({
      installed: true,
      granted: true,
    })
  })

  test("an installed app with the permission refused is not granted", async () => {
    expect(parseCompanionState(await fixture("dumpsys-ungranted.txt"))).toEqual({
      installed: true,
      granted: false,
    })
  })

  test("a missing package is neither installed nor granted", async () => {
    expect(parseCompanionState(await fixture("dumpsys-absent.txt"))).toEqual({
      installed: false,
      granted: false,
    })
    expect(parseCompanionState("")).toEqual({ installed: false, granted: false })
  })
})

describe("socketReady", () => {
  test("finds the abstract socket by its leading @", async () => {
    expect(socketReady(await fixture("proc-net-unix-ready.txt"))).toBe(true)
  })

  test("is false before the service has bound", async () => {
    expect(socketReady(await fixture("proc-net-unix-cold.txt"))).toBe(false)
    expect(socketReady("")).toBe(false)
  })

  // A filesystem socket at that path is a different thing and must not count.
  test("does not match the name without the @", () => {
    expect(socketReady("ffff8a2d: 00000002 00000000 00010000 0001 01 22104 /tmp/android-cam")).toBe(false)
  })
})

describe("ffmpegArgs", () => {
  test("puts -r before -i", () => {
    // Annex-B carries no timestamps. With -r only on the output, ffmpeg guesses a 1200k
    // tbr for the input and drops ~98% of the frames converting down to 30. This ordering
    // is the difference between 30 fps and a slideshow, and nothing else would catch a
    // reorder during a refactor.
    const args = ffmpegArgs(27183, "/dev/video3")
    expect(args.indexOf("-r")).toBeGreaterThan(-1)
    expect(args.indexOf("-r")).toBeLessThan(args.indexOf("-i"))
    expect(args[args.indexOf("-r") + 1]).toBe("30")
  })

  test("reads the forwarded port on localhost and writes the sink last", () => {
    const args = ffmpegArgs(27183, "/dev/video3")
    expect(args[args.indexOf("-i") + 1]).toBe("tcp://127.0.0.1:27183")
    expect(args.at(-1)).toBe("/dev/video3")
    expect(args).toContain("passthrough")
  })
})

describe("COMPANION_CAM", () => {
  // The APK compiles these in and has no control channel, so the setup screen must offer
  // exactly one of each rather than a list the phone cannot honour.
  test("offers exactly one camera, size and rate", () => {
    expect(COMPANION_CAM.sizes).toEqual(["1280x720"])
    expect(COMPANION_CAM.fps).toEqual([30])
    expect(COMPANION_CAM.highSpeed).toEqual({})
    expect(COMPANION_CAM.zoomRange).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/companion.test.ts`
Expected: FAIL — `Cannot find module '../src/companion'`

- [ ] **Step 4: Write `src/companion.ts`**

```ts
import type { CameraInfo } from "./scrcpy/probe"

export const PKG = "com.officialdad.androidcam"
export const SOCKET = "android-cam"
/** scrcpy's own default. Only one backend runs at a time, so there is nothing to collide with. */
export const PORT = 27183

/**
 * What the APK actually does, as constants rather than a probe result. Camera, size and
 * fps are compiled into CamService and there is no control channel to change them — and
 * asking scrcpy to list cameras on one of these phones is the very thing that fails, so
 * there is nothing to probe with either.
 */
export const COMPANION_CAM: CameraInfo = {
  id: "0",
  facing: "back",
  maxSize: "1280x720",
  fps: [30],
  zoomRange: null,
  sizes: ["1280x720"],
  highSpeed: {},
}

export interface CompanionState {
  installed: boolean
  granted: boolean
}

/**
 * One `dumpsys package <pkg>` answers both questions, so there is no second adb call.
 * An absent package prints "Unable to find package" and nothing else.
 */
export function parseCompanionState(dumpsys: string): CompanionState {
  const installed = dumpsys.includes(`Package [${PKG}]`)
  return {
    installed,
    granted: installed && /android\.permission\.CAMERA: granted=true/.test(dumpsys),
  }
}

/** /proc/net/unix lists abstract sockets with a leading `@`; a path socket is not ours. */
export function socketReady(procNetUnix: string): boolean {
  return procNetUnix.split("\n").some((line) => line.trimEnd().endsWith(`@${SOCKET}`))
}

/**
 * run.sh's invocation, verbatim. The `-r` before `-i` is load-bearing: Annex-B carries no
 * timestamps, so without it ffmpeg guesses a 1200k tbr for the input and drops ~98% of the
 * frames converting down. Do not move it to the output side.
 */
export function ffmpegArgs(port: number, sink: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-r",
    String(COMPANION_CAM.fps[0]),
    "-f",
    "h264",
    "-i",
    `tcp://127.0.0.1:${port}`,
    "-fps_mode",
    "passthrough",
    "-vf",
    "format=yuv420p",
    "-f",
    "v4l2",
    sink,
  ]
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/companion.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/companion.ts tests/companion.test.ts tests/fixtures/dumpsys-*.txt tests/fixtures/proc-net-unix-*.txt
git commit -m "feat(companion): parse the APK's install state, socket and ffmpeg command"
```

---

## Task 2: Vendor the APK and add the companion spawn wrappers

**Files:**
- Create: `src/android-cam.apk` (copied), `src/apk.d.ts`
- Modify: `src/companion.ts`, `src/scrcpy/devices.ts:30-43`
- Test: `tests/companion.test.ts`

**Interfaces:**
- Consumes: `PKG`, `SOCKET`, `PORT`, `parseCompanionState`, `socketReady` from Task 1.
- Produces: `adb(cmd: string[]): Promise<{out: string, code: number}>` exported from `src/scrcpy/devices.ts`; `APK_CACHE: string`, `materializeApk(): Promise<string | null>`, `companionState(serial: string, adbPath?: string): Promise<CompanionState>`, `prepPhone(serial: string | null, adbPath?: string, tries?: number): Promise<void>` from `src/companion.ts`.

- [ ] **Step 1: Vendor the APK and declare its module type**

```bash
cp ~/repo/android-cam/android-cam.apk src/android-cam.apk
```

Create `src/apk.d.ts`:

```ts
/**
 * `bun build --compile` embeds a file imported with this attribute into the binary and
 * resolves the import to a path `Bun.file` can read. TypeScript has no idea, hence this.
 */
declare module "*.apk" {
  const path: string
  export default path
}
```

- [ ] **Step 2: Export the adb helper**

In `src/scrcpy/devices.ts:30`, change the private helper to exported. It already handles the synchronous `Bun.spawn` throw, and duplicating that in `companion.ts` would be a second place to get it wrong:

```ts
export async function adb(cmd: string[]): Promise<{ out: string; code: number }> {
```

Nothing else in that file changes.

- [ ] **Step 3: Write the failing tests**

Append to `tests/companion.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { companionState, materializeApk, prepPhone } from "../src/companion"

/**
 * A fake adb that answers by subcommand. Written to a tmpdir per test because env vars do
 * not reach spawned children here — the behaviour is baked into the script instead.
 */
function fakeAdb(body: string) {
  const bin = join(mkdtempSync(join(tmpdir(), "adb-")), "adb")
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return bin
}

const DUMPSYS_GRANTED = `cat ${import.meta.dir}/fixtures/dumpsys-granted.txt`
const UNIX_READY = `cat ${import.meta.dir}/fixtures/proc-net-unix-ready.txt`
const UNIX_COLD = `cat ${import.meta.dir}/fixtures/proc-net-unix-cold.txt`

describe("companionState", () => {
  test("reads the phone's install state through adb", async () => {
    const bin = fakeAdb(DUMPSYS_GRANTED)
    expect(await companionState("R5CT", bin)).toEqual({ installed: true, granted: true })
  })

  test("an adb that is not there reports not installed rather than throwing", async () => {
    expect(await companionState("R5CT", "/nonexistent/adb")).toEqual({
      installed: false,
      granted: false,
    })
  })
})

describe("prepPhone", () => {
  // Every adb call is serial-scoped, and `-s <serial>` has to precede the subcommand.
  test("forwards the port and starts the service before the socket poll", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "adblog-")), "calls")
    const bin = fakeAdb(`echo "$@" >> ${log}\ncase "$*" in *"/proc/net/unix"*) ${UNIX_READY};; esac`)
    await prepPhone("R5CT", bin)
    const calls = await Bun.file(log).text()
    expect(calls).toContain("-s R5CT forward tcp:27183 localabstract:android-cam")
    expect(calls).toContain("-s R5CT shell am start-foreground-service -n com.officialdad.androidcam/.CamService")
    // No activity is ever started: waking a locked phone starts face unlock, which opens a
    // camera of its own and gets our own open rejected.
    expect(calls).not.toContain("am start -n")
  })

  test("throws with the permission hint when the service never listens", async () => {
    const bin = fakeAdb(`case "$*" in *"/proc/net/unix"*) ${UNIX_COLD};; esac`)
    expect(prepPhone("R5CT", bin, 2)).rejects.toThrow(/pm grant/)
  })

  test("a failed forward is reported rather than swallowed", async () => {
    const bin = fakeAdb(`case "$*" in *forward*) echo "error: device offline" >&2; exit 1;; esac`)
    expect(prepPhone("R5CT", bin)).rejects.toThrow(/device offline/)
  })
})

describe("materializeApk", () => {
  // The imported path addresses Bun's embedded filesystem in a compiled binary, which adb
  // cannot open. This is what turns it into a real one.
  test("writes a real, non-empty apk adb could install", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "apk-")), "android-cam.apk")
    expect(await materializeApk(dest)).toBe(dest)
    expect(Bun.file(dest).size).toBeGreaterThan(4096)
    // Every APK is a zip.
    const head = new Uint8Array(await Bun.file(dest).slice(0, 2).arrayBuffer())
    expect([head[0], head[1]]).toEqual([0x50, 0x4b])
  })

  test("an unwritable destination yields null rather than throwing", async () => {
    expect(await materializeApk("/proc/nope/android-cam.apk")).toBeNull()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test tests/companion.test.ts`
Expected: FAIL — `companionState`, `prepPhone` and `materializeApk` are not exported.

- [ ] **Step 5: Add the spawn wrappers to `src/companion.ts`**

Add the imports at the top of the file:

```ts
import apk from "./android-cam.apk" with { type: "file" }
import { adb } from "./scrcpy/devices"
```

Append:

```ts
/**
 * Tilde, not $HOME expanded: this string goes into a doctor fix line, and the doctor
 * indents those by two inside a bordered box, so an expanded path on a long username
 * blows the 76-column budget and the user pastes a broken command.
 */
export const APK_CACHE = "~/.cache/android-cam-tui/android-cam.apk"

const expand = (p: string) => p.replace(/^~/, process.env.HOME ?? "~")

/**
 * The imported path addresses Bun's embedded filesystem inside a compiled binary, which
 * `adb install` — a subprocess — cannot open. Write the bytes somewhere real first.
 */
export async function materializeApk(dest = APK_CACHE): Promise<string | null> {
  try {
    await Bun.write(expand(dest), Bun.file(apk)) // Bun.write creates parent dirs
    return dest
  } catch {
    return null
  }
}

export async function companionState(serial: string, adbPath = "adb"): Promise<CompanionState> {
  try {
    const { out } = await adb([adbPath, "-s", serial, "shell", "dumpsys", "package", PKG])
    return parseCompanionState(out)
  } catch {
    return { installed: false, granted: false } // no adb — that has its own doctor check
  }
}

/**
 * Forward the port, start the service, wait for its socket. Never starts an activity:
 * `am start-foreground-service` leaves a locked phone locked, and waking it would start
 * face unlock, which opens a camera of its own and pushes the device past the
 * system-wide open-camera limit so our own open is rejected.
 */
export async function prepPhone(serial: string | null, adbPath = "adb", tries = 30): Promise<void> {
  const base = serial ? [adbPath, "-s", serial] : [adbPath]
  // Idempotent, so it is re-run on every spawn rather than tracked and torn down.
  const fwd = await adb([...base, "forward", `tcp:${PORT}`, `localabstract:${SOCKET}`])
  if (fwd.code !== 0) throw new Error(fwd.out.trim() || "adb forward failed")
  await adb([...base, "shell", "am", "start-foreground-service", "-n", `${PKG}/.CamService`])
  // The service binds its socket a beat after the process starts; racing ffmpeg against
  // it just fails.
  for (let i = 0; i < tries; i++) {
    const { out } = await adb([...base, "shell", "cat", "/proc/net/unix"])
    if (socketReady(out)) return
    await Bun.sleep(200)
  }
  throw new Error(
    `Android Cam never listened — grant it the camera: adb shell pm grant ${PKG} android.permission.CAMERA`,
  )
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/companion.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Verify the APK survives the compile**

Run: `bun run build && ls -l dist/android-cam-tui`
Expected: the binary builds. Confirm the APK is embedded rather than merely referenced:

Run: `grep -c "android-cam.apk" dist/android-cam-tui || true`
Expected: at least one match, and the binary is larger than a build without the import. If `bun build --compile` errors on the import attribute, stop and report — the fallback is to base64 the 13 KB into a `.ts` constant, which needs a plan amendment rather than an improvised fix.

- [ ] **Step 8: Commit**

```bash
git add src/android-cam.apk src/apk.d.ts src/companion.ts src/scrcpy/devices.ts tests/companion.test.ts
git commit -m "feat(companion): vendor the APK and drive it over adb"
```

---

## Task 3: Backend field on the config

**Files:**
- Modify: `src/config.ts:3-31`, `src/doctor.ts` (add `backendFor`), `src/ui/setup.tsx` (`reconcile` and its four call sites)
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consumes: `MIN_SDK` from `src/doctor.ts`.
- Produces: `StreamConfig.backend: "scrcpy" | "companion"`; `backendFor(sdk?: number): StreamConfig["backend"]` exported from `src/doctor.ts`; `reconcile(cfg, cams, sinks, sdk?)` — a fourth optional parameter.

`backendFor` lives in `doctor.ts` because that is where `MIN_SDK` lives and there must be exactly one place the floor is compared. `setup.tsx` and `app.tsx` both already import from `doctor.ts`, and `doctor.ts` imports neither, so no cycle is created.

- [ ] **Step 1: Write the failing tests**

Add to `tests/setup.test.ts` inside the existing `describe("reconcile", ...)` block:

```ts
  // Never read from the saved file: a config outlives the phone it was written for, and
  // after a device switch it names the wrong backend more often than the right one.
  test("derives the backend from the phone's api level, overriding the saved value", () => {
    const saved = { ...DEFAULT_CONFIG, backend: "companion" as const }
    expect(reconcile(saved, cams, sinks, 34).backend).toBe("scrcpy")
    expect(reconcile({ ...DEFAULT_CONFIG }, cams, sinks, 29).backend).toBe("companion")
  })

  test("api 31 exactly is the scrcpy side of the floor", () => {
    expect(reconcile(DEFAULT_CONFIG, cams, sinks, 31).backend).toBe("scrcpy")
    expect(reconcile(DEFAULT_CONFIG, cams, sinks, 30).backend).toBe("companion")
  })

  // An unauthorized or offline phone never answered getprop. Only a phone that provably
  // reported below the floor is old; everything else has a check of its own.
  test("an unknown api level stays on scrcpy", () => {
    expect(reconcile(DEFAULT_CONFIG, cams, sinks).backend).toBe("scrcpy")
    expect(reconcile(DEFAULT_CONFIG, cams, sinks, undefined).backend).toBe("scrcpy")
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/setup.test.ts -t "backend"`
Expected: FAIL — `backend` is not a property of `StreamConfig`, and `reconcile` takes three arguments.

- [ ] **Step 3: Add the field**

In `src/config.ts`, add to the `StreamConfig` interface after `serial`:

```ts
  /**
   * Which stream path this phone needs. Derived from its API level by `reconcile()` and
   * never trusted from the saved file — a config outlives the phone it was written for.
   */
  backend: "scrcpy" | "companion"
```

and to `DEFAULT_CONFIG`:

```ts
  backend: "scrcpy",
```

`buildArgs` is untouched. It stays the scrcpy-only builder it already is.

- [ ] **Step 4: Add `backendFor` to `src/doctor.ts`**

Directly below the `MIN_SDK` declaration:

```ts
/**
 * The one place the floor is compared. An undefined sdk means the phone never answered
 * `getprop` — unauthorized, offline, mid-boot — and each of those has its own check, so
 * it is not treated as old.
 */
export function backendFor(sdk?: number): StreamConfig["backend"] {
  return sdk !== undefined && sdk < MIN_SDK ? "companion" : "scrcpy"
}
```

Add the type import at the top of `src/doctor.ts`:

```ts
import type { StreamConfig } from "./config"
```

- [ ] **Step 5: Thread it through `reconcile`**

In `src/ui/setup.tsx`, change the signature and the returned object:

```ts
export function reconcile(
  cfg: StreamConfig,
  cams: CameraInfo[],
  sinks: SinkInfo[],
  sdk?: number,
): StreamConfig {
```

and add to the returned object, next to `sink`:

```ts
    backend: backendFor(sdk),
```

Extend the existing `doctor` import in that file to include `backendFor`.

- [ ] **Step 6: Pass the sdk at all four call sites**

All four are in `src/ui/setup.tsx`:

1. `preflight()` — has `pick`:

```ts
      setConfig(reconcile({ ...cfg, serial }, cams, env.sinks, pick?.sdk))
```

2. `selectDevice()` — look the device up first:

```ts
  const selectDevice = async (serial: string) => {
    if (!config) return
    setBusy(true)
    setNotice(null)
    const dev = devices.find((d) => d.serial === serial)
    try {
      const cams = await probesRef.current.getCameras(serial)
      if (cams.length === 0) {
        setNotice(`no cameras on ${serial}`)
        return
      }
      setCameras(cams)
      setConfig(reconcile({ ...config, serial }, cams, sinks, dev?.sdk))
```

3 and 4. The camera and size `onChange` handlers in the JSX. Both must keep the current phone's backend rather than reset it, so add a single binding in the render body beside the existing `currentDevice`:

```ts
  const currentSdk = currentDevice?.sdk
```

and pass it:

```ts
              setConfig(reconcile({ ...config, cameraId: next.id, zoom: null }, cameras, sinks, currentSdk))
```

```ts
            onChange={(v) => setConfig(reconcile({ ...config, size: v }, cameras, sinks, currentSdk))}
```

- [ ] **Step 7: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: PASS. The pre-existing `reconcile` tests use `toMatchObject`, so the added field does not break them.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/doctor.ts src/ui/setup.tsx tests/setup.test.ts
git commit -m "feat(config): derive the stream backend from the phone's api level"
```

---

## Task 4: StreamRunner drives either backend

**Files:**
- Modify: `src/scrcpy/runner.ts:13-18,72-109,134-154`
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes: `PORT`, `ffmpegArgs`, `prepPhone` from `src/companion.ts`; `StreamConfig.backend` from Task 3.
- Produces: `RunnerOpts.ffmpegPath?: string` and `RunnerOpts.adbPath?: string` for test injection. `StreamRunner`'s public surface is otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/runner.test.ts`, inside `describe("StreamRunner", ...)`. Reuse the file's existing `fakeScrcpy` helper for both fakes — it writes an executable shell script to a tmpdir, which is all either needs:

```ts
  const COMPANION = { ...DEFAULT_CONFIG, backend: "companion" as const, serial: "R5CT" }
  const UNIX_READY = `cat ${import.meta.dir}/fixtures/proc-net-unix-ready.txt`
  const UNIX_COLD = `cat ${import.meta.dir}/fixtures/proc-net-unix-cold.txt`

  test("companion backend preps the phone, then spawns ffmpeg", async () => {
    const { events, onEvent } = collect()
    const log = join(mkdtempSync(join(tmpdir(), "adblog-")), "calls")
    const r = new StreamRunner({
      adbPath: fakeScrcpy(`echo "$@" >> ${log}\ncase "$*" in *"/proc/net/unix"*) ${UNIX_READY};; esac`),
      ffmpegPath: fakeScrcpy("sleep 600"),
      restartDelayMs: 50,
      onEvent,
    })
    await r.start(COMPANION)
    await waitFor(() => events.some((e) => e.kind === "started"))
    await r.stop()
    const calls = await Bun.file(log).text()
    expect(calls).toContain("forward tcp:27183 localabstract:android-cam")
    expect(calls).toContain("am start-foreground-service")
    expect(r.state).toBe("stopped")
  })

  // The prep is three adb round-trips of awaits. Without an epoch re-check after them, a
  // stop() landing mid-prep leaves ffmpeg spawned and holding the sink.
  test("stop() during the prep never spawns ffmpeg", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({
      adbPath: fakeScrcpy(`case "$*" in *"/proc/net/unix"*) ${UNIX_COLD};; esac`),
      ffmpegPath: fakeScrcpy("sleep 600"),
      restartDelayMs: 50,
      onEvent,
    })
    void r.start(COMPANION)
    await sleep(150) // mid socket-poll
    await r.stop()
    await sleep(600)
    expect(events.filter((e) => e.kind === "started").length).toBe(0)
    expect(r.state).toBe("stopped")
  })

  // A phone still booting is exactly what retries are for, so a prep failure has to land in
  // the same backoff path as a stream that died — not as an unhandled rejection.
  test("a prep failure reports the reason and retries", async () => {
    const { events, onEvent } = collect()
    const r = new StreamRunner({
      adbPath: fakeScrcpy(`case "$*" in *forward*) echo "error: device offline" >&2; exit 1;; esac`),
      ffmpegPath: fakeScrcpy("sleep 600"),
      restartDelayMs: 20,
      maxAttempts: 1,
      onEvent,
    })
    await r.start(COMPANION)
    await waitFor(() => events.some((e) => e.kind === "gave-up"))
    await r.stop()
    const exited = events.find((e) => e.kind === "exited") as Extract<StreamEvent, { kind: "exited" }>
    expect(exited.reason).toContain("device offline")
    expect(events.map((e) => e.kind)).toContain("restarting")
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/runner.test.ts -t "companion"`
Expected: FAIL — `ffmpegPath` and `adbPath` are not `RunnerOpts` properties; the companion config spawns scrcpy.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/runner.test.ts -t "prep"`
Expected: FAIL for the same reason.

- [ ] **Step 4: Add the options and the command selector**

In `src/scrcpy/runner.ts`, add the import:

```ts
import { ffmpegArgs, PORT, prepPhone } from "../companion"
```

Extend `RunnerOpts`:

```ts
interface RunnerOpts {
  scrcpyPath?: string
  ffmpegPath?: string
  adbPath?: string
  restartDelayMs?: number
  maxAttempts?: number
  onEvent: (e: StreamEvent) => void
}
```

Add the fields and their constructor defaults beside `scrcpyPath`:

```ts
  private readonly ffmpegPath: string
  private readonly adbPath: string
```

```ts
    this.ffmpegPath = opts.ffmpegPath ?? "ffmpeg"
    this.adbPath = opts.adbPath ?? "adb"
```

Add the selector as a private method:

```ts
  /** `buildArgs` stays scrcpy-only; the companion path is a different program entirely. */
  private command(): string[] {
    return this.config.backend === "companion"
      ? [this.ffmpegPath, ...ffmpegArgs(PORT, this.config.sink)]
      : [this.scrcpyPath, ...buildArgs(this.config)]
  }
```

- [ ] **Step 5: Make `spawn()` async, with the epoch re-check**

Replace `spawn()` in `src/scrcpy/runner.ts`:

```ts
  /**
   * The companion path needs three adb round-trips before ffmpeg exists, so this awaits.
   * `myEpoch` is captured before that and re-checked after it: a `stop()` or a newer
   * `start()` landing mid-prep must not leave a process holding the sink. `live.add` stays
   * ahead of the await so a runner is always reachable by the exit hook.
   */
  private async spawn(): Promise<void> {
    const myEpoch = this.epoch
    this.state = "running"
    this.startedAt = Date.now()
    this.lastLine = null
    this.lastError = null
    live.add(this)
    if (this.config.backend === "companion") {
      try {
        await prepPhone(this.config.serial, this.adbPath)
      } catch (e) {
        if (this.epoch !== myEpoch) return
        // A phone still booting is what retries are for: report the cause and fall into the
        // same backoff a mid-stream death takes, rather than rejecting out of start().
        this.lastError = e instanceof Error ? e.message : String(e)
        return this.onExit(null)
      }
      if (this.epoch !== myEpoch) return
    }
    this.proc = Bun.spawn(this.command(), {
      stdout: "pipe",
      stderr: "pipe",
    })
    this.onEvent({ kind: "started" })
    this.watch(this.proc.stdout as ReadableStream)
    this.watch(this.proc.stderr as ReadableStream)
    this.proc.exited.then((code) => this.onExit(code))
  }
```

- [ ] **Step 6: Await it at both call sites**

In `start()`:

```ts
    this.epoch++ // supersede any restart still waiting out its backoff
    await this.spawn()
```

At the end of `onExit()`:

```ts
    if (this.epoch !== myEpoch) return // stop() called, abort restart
    await this.spawn()
```

`onExit`'s existing `if (this.state !== "running") return` guard still holds on the prep-failure path, because `spawn()` sets `running` before awaiting.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/runner.test.ts && bun run typecheck`
Expected: PASS, including every pre-existing scrcpy test — the scrcpy path takes no awaits, so its timing is unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/scrcpy/runner.ts tests/runner.test.ts
git commit -m "feat(runner): supervise the companion backend alongside scrcpy"
```

---

## Task 5: Doctor reports the companion prerequisites

**Files:**
- Modify: `src/doctor.ts:47-57,62-68,70-118,136-255,273-291`, `src/scrcpy/devices.ts:1-8`
- Test: `tests/doctor.test.ts`

**Interfaces:**
- Consumes: `PKG`, `APK_CACHE`, `CompanionState`, `companionState`, `materializeApk` from Tasks 1–2.
- Produces: `Env.ffmpeg: string | null`, `Env.apkPath: string | null`, `DeviceInfo.companion?: CompanionState`. Check ids `ffmpeg`, `companion-apk`, `companion-perm`. The `device-android` check is removed.

- [ ] **Step 1: Write the failing tests**

In `tests/doctor.test.ts`, add the two new fields to the `OK` fixture:

```ts
const OK: Env = {
  scrcpy: "/usr/bin/scrcpy",
  adb: "/usr/bin/adb",
  v4l2ctl: "/usr/bin/v4l2-ctl",
  ffmpeg: "/usr/bin/ffmpeg",
  player: "/usr/bin/mpv",
  scrcpyVersion: [4, 1],
  sinks: [{ label: "Phone Cam", path: "/dev/video3" }],
  devices: [{ serial: "R5CT", model: "SM_S911B", wireless: false, state: "device" }],
  distro: "arch",
  apkPath: "~/.cache/android-cam-tui/android-cam.apk",
}
```

Replace the existing `"a phone below Android 12 blocks on its own check"` test with:

```ts
  // Android 10 answers `--list-cameras` fine and only dies once capture starts, so this
  // used to be a hard block. The companion APK serves it instead; what the doctor reports
  // now is what that path still needs.
  const READY: DeviceInfo = {
    serial: "e410cff1",
    model: "CPH1931",
    wireless: false,
    state: "device",
    sdk: 29,
    companion: { installed: true, granted: true },
  }

  test("an old phone with the companion app ready blocks on nothing", () => {
    expect(blocked({ ...OK, devices: [READY] })).toEqual([])
  })

  test("an old phone with no companion app blocks on the install", () => {
    const devices = [{ ...READY, companion: { installed: false, granted: false } }]
    expect(blocked({ ...OK, devices })).toEqual(["companion-apk"])
    expect(find({ ...OK, devices }, "companion-apk").fix.join("\n")).toContain("adb install -r -g")
  })

  // The grant is a separate failure with a separate remedy, and firing both at once would
  // have the user install an app that is already installed.
  test("an installed but ungranted app blocks on the permission alone", () => {
    const devices = [{ ...READY, companion: { installed: true, granted: false } }]
    expect(blocked({ ...OK, devices })).toEqual(["companion-perm"])
    expect(find({ ...OK, devices }, "companion-perm").fix.join("\n")).toContain("pm grant")
  })

  test("the companion path blocks without ffmpeg, and only for an old phone", () => {
    expect(blocked({ ...OK, ffmpeg: null, devices: [READY] })).toEqual(["ffmpeg"])
    expect(blocked({ ...OK, ffmpeg: null })).toEqual([])
  })

  test("a modern phone raises no companion checks at all", () => {
    const devices: DeviceInfo[] = [{ serial: "NEW", model: "", wireless: false, state: "device", sdk: 34 }]
    expect(blocked({ ...OK, ffmpeg: null, devices })).toEqual([])
  })

  // One working handset satisfies everything, the way the other device checks already work.
  test("one modern phone clears the companion checks for an old sibling", () => {
    const devices: DeviceInfo[] = [
      { ...READY, companion: { installed: false, granted: false } },
      { serial: "NEW", model: "", wireless: false, state: "device", sdk: 34 },
    ]
    expect(blocked({ ...OK, ffmpeg: null, devices })).toEqual([])
  })

  test("the apk fix names the cache path, and falls back when the write failed", () => {
    const devices = [{ ...READY, companion: { installed: false, granted: false } }]
    expect(find({ ...OK, devices }, "companion-apk").fix.join("\n")).toContain(
      "~/.cache/android-cam-tui/android-cam.apk",
    )
    const fix = find({ ...OK, devices, apkPath: null }, "companion-apk").fix.join("\n")
    expect(fix).toContain("github.com/officialdad/android-cam")
  })
```

Delete the now-stale `"one modern phone clears the android check for an old sibling"` test — the block it asserted no longer exists, and its replacement above covers the sibling rule.

In the `fixScript` describe block, add `ffmpeg: null` and an old ungranted phone to `BROKEN` so the new fix lines are covered by the shell-validity sweep:

```ts
  const BROKEN: Env = {
    ...OK,
    scrcpy: null,
    adb: null,
    v4l2ctl: null,
    ffmpeg: null,
    player: null,
    scrcpyVersion: [2, 1],
    sinks: [],
    devices: [{ serial: "R5CT", model: "", wireless: false, state: "no" }],
  }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/doctor.test.ts`
Expected: FAIL — `ffmpeg` and `apkPath` are not `Env` properties, `companion` is not a `DeviceInfo` property, and the three check ids do not exist.

- [ ] **Step 3: Add the device field**

In `src/scrcpy/devices.ts`, add the type import and the field:

```ts
import type { CompanionState } from "../companion"
```

```ts
export interface DeviceInfo {
  serial: string
  model: string
  wireless: boolean
  state: string
  /** `ro.build.version.sdk`. Undefined when the device is not reachable enough to ask. */
  sdk?: number
  /** Only filled for phones below MIN_SDK — nothing else needs the companion app. */
  companion?: CompanionState
}
```

The import is type-only and therefore erased, so the `companion.ts` → `devices.ts` value import from Task 2 stays the only runtime edge between them.

- [ ] **Step 4: Extend `Env` and `PKGS`**

In `src/doctor.ts`, add to `Env`:

```ts
  /** The companion backend pipes the phone's H.264 through it into the sink. */
  ffmpeg: string | null
```

and, after `distro`:

```ts
  /** Where `probeEnv` put the vendored APK, for the install fix line. Null if it could not. */
  apkPath: string | null
```

Add `ffmpeg` to the `Pkgs` interface and to all five `PKGS` entries:

```ts
  arch:    ffmpeg: ["sudo pacman -S ffmpeg"],
  debian:  ffmpeg: ["sudo apt install ffmpeg"],
  fedora:  ffmpeg: ["sudo dnf install ffmpeg-free"],
  suse:    ffmpeg: ["sudo zypper install ffmpeg"],
  unknown: ffmpeg: ["# install ffmpeg with your package manager"],
```

- [ ] **Step 5: Replace `device-android` with the three companion checks**

In `checks()`, replace the `tooOld` binding:

```ts
  // An old phone is serviceable now, so this is no longer a failure — it is the trigger for
  // a different set of prerequisites. `needsCompanion` follows the same mutual exclusion the
  // other device checks use: one working modern handset satisfies everything.
  const old = env.devices.find((d) => d.state === "device" && d.sdk !== undefined && d.sdk < MIN_SDK)
  const needsCompanion = !usable && old !== undefined
  const companion = old?.companion
```

Delete the whole `device-android` entry and put these three in its place:

```ts
    {
      id: "ffmpeg",
      level: "block",
      ok: !needsCompanion || env.ffmpeg !== null,
      detail: "ffmpeg is not on PATH — the companion backend streams through it",
      fix: pkg.ffmpeg,
    },
    {
      id: "companion-apk",
      level: "block",
      ok: !needsCompanion || (companion?.installed ?? false),
      detail: `phone runs API ${old?.sdk ?? ""} — it needs the Android Cam companion app`,
      fix: [
        "# scrcpy cannot mirror a camera before Android 12, so an installed app",
        "# holding its own CAMERA permission streams it instead",
        env.apkPath
          ? `adb install -r -g ${env.apkPath}`
          : "# build it: https://github.com/officialdad/android-cam",
      ],
    },
    {
      id: "companion-perm",
      level: "block",
      ok: !needsCompanion || !companion?.installed || companion.granted,
      detail: "Android Cam has no camera permission — this ROM refused `install -g`",
      fix: [
        `adb shell pm grant ${PKG} android.permission.CAMERA`,
        "# or by hand: Settings > Apps > Android Cam > Permissions > Camera",
      ],
    },
```

Add the import at the top of `src/doctor.ts`:

```ts
import { APK_CACHE, companionState, materializeApk, PKG } from "./companion"
```

Verify the two longest fix lines against the 76-column budget before running anything: `adb install -r -g ~/.cache/android-cam-tui/android-cam.apk` is 58 characters and `adb shell pm grant com.officialdad.androidcam android.permission.CAMERA` is 70. Both clear it with the two-space indent.

- [ ] **Step 6: Fill the new fields in `probeEnv()`**

Replace the body of `probeEnv()`. The companion round-trip and the APK write both happen only when an old phone is actually attached, so a modern-phone-only setup pays nothing:

```ts
export async function probeEnv(): Promise<Env> {
  const scrcpy = Bun.which("scrcpy")
  const [sinks, devices, osRelease, versionText] = await Promise.all([
    probeSinks(),
    listDevices(),
    Bun.file("/etc/os-release").text().catch(() => ""),
    scrcpy ? run([scrcpy, "--version"]) : Promise.resolve(""),
  ])
  // Only phones that provably answered below the floor need the companion app, so nothing
  // else is asked and nothing is written on a modern-phone-only machine.
  const old = devices.filter((d) => d.state === "device" && d.sdk !== undefined && d.sdk < MIN_SDK)
  // Kept as two entries rather than a spread, so this stays a tuple and `apkPath` keeps
  // its `string | null` type instead of widening to include the probes' void.
  const [apkPath] = await Promise.all([
    old.length > 0 ? materializeApk(APK_CACHE) : Promise.resolve(null),
    Promise.all(
      old.map(async (d) => {
        d.companion = await companionState(d.serial)
      }),
    ),
  ])
  return {
    scrcpy,
    adb: Bun.which("adb"),
    v4l2ctl: Bun.which("v4l2-ctl"),
    ffmpeg: Bun.which("ffmpeg"),
    player: PLAYERS.map((p) => Bun.which(p)).find((p) => p !== null) ?? null,
    scrcpyVersion: parseScrcpyVersion(versionText),
    sinks,
    devices,
    distro: detectDistro(osRelease),
    apkPath,
  }
}
```

`materializeApk` already swallows its own failures and returns null, so `probeEnv`'s never-rejects contract holds.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/doctor.test.ts && bun run typecheck`
Expected: PASS, including the 76-column and shell-validity sweeps over all five distros.

- [ ] **Step 8: Check the doctor against a real machine**

Run: `bun run src/index.tsx --doctor`
Expected: it renders. With only a modern phone (or none) attached, no companion check appears.

- [ ] **Step 9: Commit**

```bash
git add src/doctor.ts src/scrcpy/devices.ts tests/doctor.test.ts
git commit -m "feat(doctor): report companion prerequisites instead of blocking old phones"
```

---

## Task 6: Setup screen offers what the companion path can actually do

**Files:**
- Modify: `src/ui/setup.tsx:12-14,151-212,257-269,286-408`
- Test: `tests/setup-render.test.tsx`

**Interfaces:**
- Consumes: `COMPANION_CAM`, `ffmpegArgs`, `PORT` from Task 1; `backendFor` from Task 3.
- Produces: `fieldsFor(backend: StreamConfig["backend"]): Field[]` exported from `src/ui/setup.tsx`.

- [ ] **Step 1: Write the failing tests**

In `tests/setup-render.test.tsx`, add `ffmpeg: "/usr/bin/ffmpeg"` and `apkPath: "~/.cache/android-cam-tui/android-cam.apk"` to the `HEALTHY` fixture, and `ffmpeg: null` to `BARE`. Then add to `tests/setup.test.ts`:

```ts
import { fieldsFor } from "../src/ui/setup"

describe("fieldsFor", () => {
  // Bitrate, zoom, rotate and buffer are all scrcpy flags. The APK compiles its settings in
  // and has no control channel, so a stepper for them would silently do nothing — worse
  // than not being there.
  test("the companion path drops every field it cannot honour", () => {
    expect(fieldsFor("companion")).toEqual(["device", "camera", "size", "sink"])
  })

  test("the scrcpy path keeps all of them", () => {
    expect(fieldsFor("scrcpy")).toContain("bitrate")
    expect(fieldsFor("scrcpy")).toContain("zoom")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/setup.test.ts -t "fieldsFor"`
Expected: FAIL — `fieldsFor` is not exported.

- [ ] **Step 3: Add the field lists**

In `src/ui/setup.tsx`, replace the `FIELDS`/`OUTPUT_FIELDS` block:

```ts
const FIELDS = ["device", "camera", "size", "fps", "zoom", "bitrate", "orientation", "buffer", "sink"] as const
type Field = (typeof FIELDS)[number]
const OUTPUT_FIELDS: Field[] = ["fps", "zoom", "bitrate", "orientation", "buffer", "sink"]

/**
 * The companion APK compiles camera, size, fps and bitrate in and has no control channel,
 * so tab must not land on a stepper that cannot do anything. Camera and size stay: they are
 * single-option and showing them is how the ceiling is visible.
 */
export function fieldsFor(backend: StreamConfig["backend"]): Field[] {
  return backend === "companion" ? ["device", "camera", "size", "sink"] : [...FIELDS]
}
```

- [ ] **Step 4: Use the constant instead of probing on the companion path**

Add the import:

```ts
import { COMPANION_CAM, ffmpegArgs, PORT } from "../companion"
```

In `preflight()`, replace the probe call:

```ts
      // Asking scrcpy to list cameras on a pre-12 phone is the very thing that fails on the
      // ROMs this path exists for, and the APK would ignore the answer anyway.
      const cams =
        backendFor(pick?.sdk) === "companion"
          ? [COMPANION_CAM]
          : await probesRef.current.getCameras(serial)
```

In `selectDevice()`, the same, using the `dev` binding added in Task 3:

```ts
      const cams =
        backendFor(dev?.sdk) === "companion" ? [COMPANION_CAM] : await probesRef.current.getCameras(serial)
```

Both `cams.length === 0` guards stay as they are. They can only fire on the scrcpy path now, which is where they belong.

- [ ] **Step 5: Drive tab and the output box from the active list**

In the `useKeyboard` handler, replace the tab branch:

```ts
    if (key.name === "tab") {
      const fields = fieldsFor(config?.backend ?? "scrcpy")
      const step = key.shift ? -1 : 1
      setField((f) => fields[(fields.indexOf(f) + step + fields.length) % fields.length])
    }
```

In the render body, beside `outputFocused`:

```ts
  const companion = config.backend === "companion"
  const outputFocused = OUTPUT_FIELDS.includes(field)
```

Guard each stepper in the output box that the companion path cannot honour — `fps`, `zoom`, `bitrate`, `rotate` and `buffer` — by wrapping them in a single `{!companion && (<>...</>)}` fragment. The `sink` stepper and its label stay outside it, always rendered.

- [ ] **Step 6: Show the real command and the ceiling**

Replace the command preview line at the bottom of the render so what is displayed is always what will run:

```ts
      <text fg="#888">
        {companion
          ? `ffmpeg ${ffmpegArgs(PORT, config.sink).join(" ")}`
          : `scrcpy ${buildArgs(config).join(" ")}`}
      </text>
```

and add, directly above it:

```ts
      {companion && <text fg="yellow">companion backend — 1280x720@30 fixed, no zoom or torch</text>}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Check it renders**

Run: `bun run demo`
Expected: the fixture setup screen still renders with all steppers — the demo uses a modern fixture device, so it takes the scrcpy path.

- [ ] **Step 9: Commit**

```bash
git add src/ui/setup.tsx tests/setup.test.ts tests/setup-render.test.tsx
git commit -m "feat(setup): offer only what the companion backend can honour"
```

---

## Task 7: Dashboard and app wiring

**Files:**
- Modify: `src/ui/dashboard.tsx:11-26,48-70,97`, `src/app.tsx:33-59`
- Test: `tests/widgets.test.tsx` is untouched; verification is `bun test` plus a manual run.

**Interfaces:**
- Consumes: `COMPANION_CAM` from Task 1, `backendFor` from Task 3, `StreamConfig.backend`.
- Produces: nothing new. `Dashboard`'s props are unchanged; it reads `props.config.backend`.

- [ ] **Step 1: Make the exit log honest about which program died**

In `src/ui/dashboard.tsx`, `eventToLog`'s `exited` case names scrcpy, which is wrong half the time now:

```ts
    case "exited":
      return `stream exited (code ${e.code})${e.reason ? ` — ${e.reason}` : ""}`
```

- [ ] **Step 2: Make the inert keys inert**

In the `useKeyboard` handler, guard the two keys with no control channel behind them. Leaving them live would restart the stream to apply a change the APK cannot make:

```ts
  const companion = props.config.backend === "companion"

  useKeyboard((key) => {
    if (key.name === "z" && !companion) props.onZoomCycle()
    if (key.name === "l") props.onCameraCycle()
    if (key.name === "t" && !companion) props.onTorchToggle()
    if (key.name === "p") setNotice(props.onPreview())
    if (key.name === "r") props.onRestart()
    if (key.name === "s") props.onStop()
    if (key.name === "q") props.onQuit()
  })
```

`l` needs no guard: `onCameraCycle` already returns early on a one-camera list, and `COMPANION_CAM` is that list.

- [ ] **Step 3: Show the backend, hide the fields it does not have**

Replace the `fields` binding:

```ts
  const fields: [string, string][] = companion
    ? [
        ["camera", "back"],
        ["size", props.config.size],
        ["fps", String(props.config.fps)],
        ["sink", props.config.sink],
      ]
    : [
        ["camera", props.config.cameraId],
        ["size", props.config.size],
        ["fps", props.config.highSpeed ? `${props.config.fps} hs` : String(props.config.fps)],
        ["bitrate", props.config.bitrate],
        ["zoom", props.config.zoom === null ? "auto" : `${props.config.zoom}x`],
        ["torch", props.config.torch ? "on" : "off"],
        ["sink", props.config.sink],
      ]
```

Add the backend to the status row, after `drops`:

```ts
        <text fg="#888">{companion ? "companion" : "scrcpy"}</text>
```

and drop the two dead keys from the footer hint:

```ts
      <text fg="cyan">
        {companion
          ? "l: camera · p: preview · r: restart · s: stop → setup · q: quit"
          : "z: zoom · l: camera · t: torch · p: preview · r: restart · s: stop → setup · q: quit"}
      </text>
```

- [ ] **Step 4: Fix the camera list and `--start` in `src/app.tsx`**

In `start()`, the probe must not run on the companion path — same reason as the setup screen:

```ts
        camerasRef.current =
          c.backend === "companion" ? [COMPANION_CAM] : await probeCameras("scrcpy", c.serial)
```

`--start` skips the setup screen entirely, so nothing has run `reconcile()` and the saved `backend` is whatever the last phone needed. Re-derive it from the phone that is actually attached:

```ts
  // `--start` skips the setup screen with the last-used config. Nothing has reconciled it,
  // so the backend is re-derived here — a config written for one phone must not pick the
  // wrong stream path for another. A config the phone can no longer satisfy just fails the
  // probe, and start() already falls back to setup.
  useEffect(() => {
    if (!props.autoStart) return
    void (async () => {
      const cfg = await loadConfig()
      const devices = await listDevices()
      const dev = devices.find((d) => d.serial === cfg.serial) ?? devices.find((d) => d.state === "device")
      await start({ ...cfg, serial: dev?.serial ?? cfg.serial, backend: backendFor(dev?.sdk) })
    })()
  }, [props.autoStart, start])
```

Add the imports:

```ts
import { COMPANION_CAM } from "./companion"
import { backendFor } from "./doctor"
import { listDevices } from "./scrcpy/devices"
```

- [ ] **Step 5: Run the suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: End-to-end check on real hardware**

With the pre-Android-12 phone attached over USB, screen off and locked:

```bash
sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"
bun run src/index.tsx --doctor     # should name the install and grant, not a dead end
adb install -r -g ~/.cache/android-cam-tui/android-cam.apk
bun start                          # pick the old phone, Enter, then p to preview
```

Expected: the dashboard reaches `RUNNING` and shows `companion`; `p` opens a 1280x720 preview with motion at roughly 30 fps, not a slideshow. The phone stays locked with its screen off throughout — if it wakes, something started an activity and that is a bug, not a cosmetic issue.

If it never starts, the diagnosis is in `adb logcat -d -s android-cam`.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard.tsx src/app.tsx
git commit -m "feat(dashboard): show the active backend and retire its dead keys"
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update `README.md`**

Add a section covering: pre-Android-12 phones and ROMs that revoke `CAMERA` from `com.android.shell` are supported through a companion APK; it is vendored in the binary and the doctor prints the `adb install -r -g` line; the ceiling is 1280x720 at 30 fps with no zoom, torch or rotation; `ffmpeg` is required on that path. Note that the APK's source lives at `https://github.com/officialdad/android-cam`, and that it is a foreground service with no activity, so the phone is never woken or unlocked.

- [ ] **Step 2: Update `CLAUDE.md`**

Four edits, matching the file's existing structure:

1. Add to the pure/spawner table under "Everything is a subprocess":

```
| `parseCompanionState`, `socketReady`, `ffmpegArgs` | `companionState`, `prepPhone` | `src/companion.ts` |
```

2. Add a "Two backends" paragraph near that table: `StreamConfig.backend` is derived from the phone's API level by `backendFor()` in `src/doctor.ts` and **never read from the saved config** — a config outlives the phone it was written for. Below `MIN_SDK` the runner preps the phone over adb and spawns `ffmpeg`; the APK's capabilities are the `COMPANION_CAM` constant rather than a probe, because probing is what fails on those devices and the APK has no control channel to honour the answer anyway. The `-r 30` before `-i` in `ffmpegArgs` is load-bearing.

3. Extend the "StreamRunner epochs" section: `spawn()` is now async on the companion path and captures `myEpoch` before `prepPhone` and re-checks after it. A prep failure routes into `onExit` rather than rejecting, so it inherits the backoff.

4. Update the runtime-deps paragraph: `ffmpeg` is required for the companion backend, and the existing note that the phone does not need unlocking now covers both paths — `am start-foreground-service` never wakes it either.

- [ ] **Step 3: Verify the docs match the code**

Run: `bun test && bun run typecheck && bun run src/index.tsx --doctor`
Expected: PASS, and the doctor output matches what the README describes.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: cover the companion backend for pre-Android-12 phones"
```

---

## Self-Review Notes

Spec sections and the task that implements each:

| Spec section | Task |
|---|---|
| Backend selection | 3 |
| Companion capabilities are constant | 1 (constant), 6 (used) |
| `src/companion.ts` parsers | 1 |
| `src/companion.ts` spawners | 2 |
| APK vendoring | 2 |
| StreamRunner | 4 |
| Doctor | 5 |
| Setup screen | 6 |
| Dashboard | 7 |
| Testing | 1, 2, 3, 4, 5, 6 |
| Deliberate ceilings | 8 (documented) |

Two spec details that surfaced during planning and are resolved in the tasks rather than the spec:

- **`MIN_SDK` comparison is extracted to `backendFor()`** (Task 3) rather than inlined in `reconcile()`. `app.tsx`'s `--start` path needs the same rule and has no `reconcile()` call to route through, and two copies of a version floor is exactly the sort of thing that drifts.
- **The APK cache path is stored tilde-form, not expanded** (Task 2). `probeEnv` expands it to write; the doctor prints the tilde. An expanded `/home/<longname>/...` blows the 76-column fix-line budget on some machines and the existing test would only catch it for the developer's own username.
