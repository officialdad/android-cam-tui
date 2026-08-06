# android-cam-tui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal UI (OpenTUI/React on Bun) that configures and supervises scrcpy streaming an Android phone camera into a v4l2loopback webcam device.

**Architecture:** Single Bun process. Pure parser/config modules feed a StreamRunner that spawns scrcpy, classifies its stderr into events, and auto-restarts with backoff. Two React screens (Setup, Dashboard) over that runner. Spec: `docs/superpowers/specs/2026-08-06-android-cam-tui-design.md`.

**Tech Stack:** Bun (runtime + test runner), TypeScript, `@opentui/react` + `@opentui/core`, react. External binaries at runtime: `scrcpy`, `adb`, `v4l2-ctl`.

## Global Constraints

- Runtime is Bun; tests run with `bun test`; spawn processes with `Bun.spawn`.
- Never hardcode camera capabilities — everything comes from probing the device.
- scrcpy flags always include `--video-source=camera --no-window --stay-awake --no-audio`.
- Phone prep before every stream start: `adb shell input keyevent KEYCODE_WAKEUP` then `adb shell wm dismiss-keyguard` (Samsung evicts adb camera clients when keyguard engages).
- Config persistence path: `~/.config/android-cam-tui/config.json`.
- Spec deviation (agreed): no one-key sudo modprobe — a sudo password prompt corrupts a raw-mode TUI. When no sink exists, display the exact `sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"` command for the user to run in another shell.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/index.tsx`, `.gitignore`

**Interfaces:**
- Produces: runnable `bun run src/index.tsx` TUI entry; `bun test` working.

- [ ] **Step 1: Init project and install deps**

```bash
cd /home/ariff/repo/android-cam-tui
bun init -y
bun add @opentui/react @opentui/core react
bun add -d @types/react typescript
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "types": ["bun-types"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write .gitignore**

```
node_modules/
```

- [ ] **Step 4: Write minimal entry `src/index.tsx`**

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return <text>android-cam-tui</text>
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

- [ ] **Step 5: Smoke test**

Run: `timeout 3 bun run src/index.tsx; echo "exit $?"`
Expected: renders "android-cam-tui" in terminal, exit 124 (killed by timeout) — proves it starts and stays up.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold bun + opentui react project"
```

---

### Task 2: Probe parsers

**Files:**
- Create: `src/scrcpy/probe.ts`, `tests/probe.test.ts`, `tests/fixtures/list-camera-sizes.txt`, `tests/fixtures/v4l2-devices.txt`

**Interfaces:**
- Produces:
  - `interface CameraInfo { id: string; facing: "back" | "front" | "external"; maxSize: string; fps: number[]; zoomRange: [number, number] | null; sizes: string[] }`
  - `parseCameras(text: string): CameraInfo[]` — parses `scrcpy --list-camera-sizes` output (which includes the `--list-cameras` header lines), sizes attached per camera.
  - `interface SinkInfo { label: string; path: string }`
  - `parseSinks(text: string): SinkInfo[]` — parses `v4l2-ctl --list-devices` output, keeps only `platform:v4l2loopback` devices.
  - `probeCameras(scrcpyPath?: string): Promise<CameraInfo[]>` — spawns scrcpy, feeds parseCameras.
  - `probeSinks(): Promise<SinkInfo[]>` — spawns v4l2-ctl, feeds parseSinks.

- [ ] **Step 1: Write fixture `tests/fixtures/list-camera-sizes.txt`** (verbatim capture from Galaxy S23, trimmed)

```
scrcpy 4.1 <https://github.com/Genymobile/scrcpy>
INFO: ADB device found:
INFO:     -->   (usb)  RFCW10PK5MF                     device  SM_S911B
    --camera-id=0    (back, 4080x3060, fps={10, 15, 24, 26, 27, 30}, zoom-range=[0.6, 10])
        - 4080x3060
        - 3840x2160
        - 2560x1440
        - 1920x1080
        - 1280x720
      High speed capture (--camera-high-speed):
        - 1280x720 (fps={120, 240})
        - 1920x1080 (fps={120, 240})
    --camera-id=1    (front, 4000x3000, fps={10, 15, 24, 30}, zoom-range=[1, 8])
        - 4000x3000
        - 1920x1080
    --camera-id=2    (back, 4000x3000, fps={10, 15, 24, 30}, zoom-range=[1, 8])
        - 4000x3000
        - 1920x1080
    --camera-id=3    (front, 3392x2544, fps={10, 15, 24, 30}, zoom-range=[1, 8])
        - 3392x2544
```

- [ ] **Step 2: Write fixture `tests/fixtures/v4l2-devices.txt`**

```
Brio 100 (usb-0000:00:14.0-3.2.1):
	/dev/video0
	/dev/video1

Phone Cam (platform:v4l2loopback-000):
	/dev/video3
```

- [ ] **Step 3: Write failing tests `tests/probe.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import { parseCameras, parseSinks } from "../src/scrcpy/probe"

const camText = await Bun.file(new URL("./fixtures/list-camera-sizes.txt", import.meta.url)).text()
const v4l2Text = await Bun.file(new URL("./fixtures/v4l2-devices.txt", import.meta.url)).text()

describe("parseCameras", () => {
  const cams = parseCameras(camText)

  test("finds all four cameras", () => {
    expect(cams.map((c) => c.id)).toEqual(["0", "1", "2", "3"])
  })

  test("parses facing, fps, zoom range", () => {
    expect(cams[0].facing).toBe("back")
    expect(cams[0].fps).toEqual([10, 15, 24, 26, 27, 30])
    expect(cams[0].zoomRange).toEqual([0.6, 10])
    expect(cams[1].facing).toBe("front")
  })

  test("attaches normal sizes, excludes high-speed section", () => {
    expect(cams[0].sizes).toContain("2560x1440")
    expect(cams[0].sizes).toContain("4080x3060")
    // 1280x720 appears in both normal and high-speed lists; it must appear once
    expect(cams[0].sizes.filter((s) => s === "1280x720")).toEqual(["1280x720"])
    expect(cams[3].sizes).toEqual(["3392x2544"])
  })
})

describe("parseSinks", () => {
  test("keeps only v4l2loopback devices", () => {
    expect(parseSinks(v4l2Text)).toEqual([{ label: "Phone Cam", path: "/dev/video3" }])
  })
})
```

- [ ] **Step 4: Run tests, verify failure**

Run: `bun test tests/probe.test.ts`
Expected: FAIL — cannot resolve `../src/scrcpy/probe`.

- [ ] **Step 5: Implement `src/scrcpy/probe.ts`**

```ts
export interface CameraInfo {
  id: string
  facing: "back" | "front" | "external"
  maxSize: string
  fps: number[]
  zoomRange: [number, number] | null
  sizes: string[]
}

export interface SinkInfo {
  label: string
  path: string
}

const CAM_RE =
  /--camera-id=(\d+)\s+\((back|front|external), (\d+x\d+), fps=\{([\d, ]+)\}(?:, zoom-range=\[([\d.]+), ([\d.]+)\])?\)/

export function parseCameras(text: string): CameraInfo[] {
  const cams: CameraInfo[] = []
  let current: CameraInfo | null = null
  let inHighSpeed = false
  for (const line of text.split("\n")) {
    const m = line.match(CAM_RE)
    if (m) {
      current = {
        id: m[1],
        facing: m[2] as CameraInfo["facing"],
        maxSize: m[3],
        fps: m[4].split(",").map((s) => Number(s.trim())),
        zoomRange: m[5] ? [Number(m[5]), Number(m[6])] : null,
        sizes: [],
      }
      cams.push(current)
      inHighSpeed = false
      continue
    }
    if (/High speed capture/.test(line)) {
      inHighSpeed = true
      continue
    }
    const size = line.match(/^\s+- (\d+x\d+)\s*$/)
    if (size && current && !inHighSpeed) current.sizes.push(size[1])
  }
  return cams
}

export function parseSinks(text: string): SinkInfo[] {
  const sinks: SinkInfo[] = []
  const blocks = text.split(/\n(?=\S)/)
  for (const block of blocks) {
    const header = block.match(/^(.+?) \(platform:v4l2loopback[^)]*\):/)
    const dev = block.match(/^\s+(\/dev\/video\d+)/m)
    if (header && dev) sinks.push({ label: header[1], path: dev[1] })
  }
  return sinks
}

export async function probeCameras(scrcpyPath = "scrcpy"): Promise<CameraInfo[]> {
  const proc = Bun.spawn([scrcpyPath, "--list-camera-sizes"], { stderr: "pipe", stdout: "pipe" })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return parseCameras(out + "\n" + err)
}

export async function probeSinks(): Promise<SinkInfo[]> {
  const proc = Bun.spawn(["v4l2-ctl", "--list-devices"], { stdout: "pipe", stderr: "ignore" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return parseSinks(out)
}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `bun test tests/probe.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/scrcpy/probe.ts tests/ && git commit -m "feat: scrcpy camera and v4l2 sink probe parsers"
```

---

### Task 3: Config model, flag builder, persistence

**Files:**
- Create: `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `interface StreamConfig { cameraId: string; size: string; fps: number; bitrate: string; zoom: number | null; sink: string }`
  - `const DEFAULT_CONFIG: StreamConfig` — cameraId "0", size "1920x1080", fps 30, bitrate "16M", zoom null, sink "/dev/video3".
  - `buildArgs(c: StreamConfig): string[]` — full scrcpy argv (without binary name).
  - `loadConfig(path?: string): Promise<StreamConfig>` — returns DEFAULT_CONFIG merged with whatever parses; DEFAULT_CONFIG on missing/corrupt file.
  - `saveConfig(c: StreamConfig, path?: string): Promise<void>` — mkdir -p parent, write JSON.
  - Default path: `${process.env.HOME}/.config/android-cam-tui/config.json` (exported as `CONFIG_PATH`).

- [ ] **Step 1: Write failing tests `tests/config.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import { buildArgs, DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config"

describe("buildArgs", () => {
  test("builds full flag set", () => {
    expect(buildArgs(DEFAULT_CONFIG)).toEqual([
      "--video-source=camera",
      "--camera-id=0",
      "--camera-size=1920x1080",
      "--camera-fps=30",
      "--video-bit-rate=16M",
      "--v4l2-sink=/dev/video3",
      "--no-window",
      "--stay-awake",
      "--no-audio",
    ])
  })

  test("appends zoom only when set", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, zoom: 0.6 })).toContain("--camera-zoom=0.6")
    expect(buildArgs(DEFAULT_CONFIG).join(" ")).not.toContain("--camera-zoom")
  })
})

describe("persistence", () => {
  const tmp = `/tmp/act-test-${process.pid}/config.json`

  test("round-trips config", async () => {
    const cfg = { ...DEFAULT_CONFIG, size: "2560x1440", zoom: 0.6 }
    await saveConfig(cfg, tmp)
    expect(await loadConfig(tmp)).toEqual(cfg)
  })

  test("missing file returns defaults", async () => {
    expect(await loadConfig("/tmp/act-nonexistent/nope.json")).toEqual(DEFAULT_CONFIG)
  })

  test("corrupt file returns defaults", async () => {
    await Bun.write(tmp, "{not json")
    expect(await loadConfig(tmp)).toEqual(DEFAULT_CONFIG)
  })
})
```

- [ ] **Step 2: Run tests, verify failure**

Run: `bun test tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
export interface StreamConfig {
  cameraId: string
  size: string
  fps: number
  bitrate: string
  zoom: number | null
  sink: string
}

export const DEFAULT_CONFIG: StreamConfig = {
  cameraId: "0",
  size: "1920x1080",
  fps: 30,
  bitrate: "16M",
  zoom: null,
  sink: "/dev/video3",
}

export const CONFIG_PATH = `${process.env.HOME}/.config/android-cam-tui/config.json`

export function buildArgs(c: StreamConfig): string[] {
  const args = [
    "--video-source=camera",
    `--camera-id=${c.cameraId}`,
    `--camera-size=${c.size}`,
    `--camera-fps=${c.fps}`,
    `--video-bit-rate=${c.bitrate}`,
    `--v4l2-sink=${c.sink}`,
    "--no-window",
    "--stay-awake",
    "--no-audio",
  ]
  if (c.zoom !== null) args.push(`--camera-zoom=${c.zoom}`)
  return args
}

export async function loadConfig(path = CONFIG_PATH): Promise<StreamConfig> {
  try {
    const data = await Bun.file(path).json()
    return { ...DEFAULT_CONFIG, ...data }
  } catch {
    return DEFAULT_CONFIG
  }
}

export async function saveConfig(c: StreamConfig, path = CONFIG_PATH): Promise<void> {
  await Bun.write(path, JSON.stringify(c, null, 2)) // Bun.write creates parent dirs
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test tests/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts && git commit -m "feat: stream config, flag builder, persistence"
```

---

### Task 4: StreamRunner

**Files:**
- Create: `src/scrcpy/runner.ts`, `tests/runner.test.ts`, `tests/fixtures/fake-scrcpy.sh`

**Interfaces:**
- Consumes: `StreamConfig`, `buildArgs` from `src/config.ts`.
- Produces:
  - `type StreamEvent = { kind: "started" } | { kind: "camera-evicted" } | { kind: "device-lost" } | { kind: "exited"; code: number | null } | { kind: "restarting"; attempt: number }`
  - `type RunnerState = "idle" | "running" | "restarting" | "stopped"`
  - `class StreamRunner { constructor(opts: { scrcpyPath?: string; adbPath?: string; restartDelayMs?: number; onEvent: (e: StreamEvent) => void }); state: RunnerState; startedAt: number | null; start(c: StreamConfig): Promise<void>; stop(): Promise<void>; restart(c: StreamConfig): Promise<void> }`
  - Behavior: `start` runs phone prep (`adb shell input keyevent KEYCODE_WAKEUP`; `adb shell wm dismiss-keyguard`, failures ignored), spawns scrcpy with `buildArgs`, watches stderr+stdout lines: `Camera disconnected` → camera-evicted event; `Device disconnected` → device-lost event. On process exit while state is "running": emit exited, then restarting with incrementing attempt, wait `restartDelayMs` (default 2000), respawn with last config. `stop()` sets state "stopped" first so exit does not trigger restart, then kills child.

- [ ] **Step 1: Write fixture `tests/fixtures/fake-scrcpy.sh`** (mimics real death output; MODE env selects behavior)

```bash
#!/bin/bash
# Fake scrcpy for runner tests. MODE: die-evicted | run-forever
echo "[server] INFO: Using camera '0'" >&2
case "${MODE:-die-evicted}" in
  die-evicted)
    sleep 0.2
    echo "[server] WARN: Camera disconnected" >&2
    echo "WARN: Device disconnected" >&2
    exit 2
    ;;
  run-forever)
    sleep 600
    ;;
esac
```

Then: `chmod +x tests/fixtures/fake-scrcpy.sh`

- [ ] **Step 2: Write failing tests `tests/runner.test.ts`**

```ts
import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config"
import { StreamRunner, type StreamEvent } from "../src/scrcpy/runner"

const FAKE = new URL("./fixtures/fake-scrcpy.sh", import.meta.url).pathname

function collect() {
  const events: StreamEvent[] = []
  return { events, onEvent: (e: StreamEvent) => events.push(e) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("StreamRunner", () => {
  test("classifies eviction death and auto-restarts", async () => {
    const { events, onEvent } = collect()
    process.env.MODE = "die-evicted"
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: "true", restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await sleep(700) // fake dies at ~200ms, restart at ~250ms, dies again ~450ms
    await r.stop()
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain("started")
    expect(kinds).toContain("camera-evicted")
    expect(kinds).toContain("device-lost")
    expect(kinds).toContain("restarting")
    const attempts = events.filter((e) => e.kind === "restarting").map((e: any) => e.attempt)
    expect(attempts[0]).toBe(1)
    expect(attempts.length).toBeGreaterThanOrEqual(2)
  })

  test("stop() prevents restart and reaches stopped state", async () => {
    const { events, onEvent } = collect()
    process.env.MODE = "run-forever"
    const r = new StreamRunner({ scrcpyPath: FAKE, adbPath: "true", restartDelayMs: 50, onEvent })
    await r.start(DEFAULT_CONFIG)
    await sleep(100)
    await r.stop()
    await sleep(200)
    expect(r.state).toBe("stopped")
    expect(events.map((e) => e.kind)).not.toContain("restarting")
  })
})
```

- [ ] **Step 3: Run tests, verify failure**

Run: `bun test tests/runner.test.ts`
Expected: FAIL — cannot resolve `../src/scrcpy/runner`.

- [ ] **Step 4: Implement `src/scrcpy/runner.ts`**

```ts
import { buildArgs, type StreamConfig } from "../config"

export type StreamEvent =
  | { kind: "started" }
  | { kind: "camera-evicted" }
  | { kind: "device-lost" }
  | { kind: "exited"; code: number | null }
  | { kind: "restarting"; attempt: number }

export type RunnerState = "idle" | "running" | "restarting" | "stopped"

interface RunnerOpts {
  scrcpyPath?: string
  adbPath?: string
  restartDelayMs?: number
  onEvent: (e: StreamEvent) => void
}

export class StreamRunner {
  state: RunnerState = "idle"
  startedAt: number | null = null
  private proc: Bun.Subprocess | null = null
  private config!: StreamConfig
  private attempt = 0
  private readonly scrcpyPath: string
  private readonly adbPath: string
  private readonly restartDelayMs: number
  private readonly onEvent: (e: StreamEvent) => void

  constructor(opts: RunnerOpts) {
    this.scrcpyPath = opts.scrcpyPath ?? "scrcpy"
    this.adbPath = opts.adbPath ?? "adb"
    this.restartDelayMs = opts.restartDelayMs ?? 2000
    this.onEvent = opts.onEvent
  }

  async start(config: StreamConfig): Promise<void> {
    this.config = config
    this.attempt = 0
    await this.prepPhone()
    this.spawn()
  }

  async restart(config: StreamConfig): Promise<void> {
    await this.stop()
    await this.start(config)
  }

  async stop(): Promise<void> {
    this.state = "stopped"
    if (this.proc) {
      this.proc.kill()
      await this.proc.exited
      this.proc = null
    }
  }

  private async prepPhone(): Promise<void> {
    // Samsung evicts adb camera clients the moment the keyguard engages.
    for (const args of [
      ["shell", "input", "keyevent", "KEYCODE_WAKEUP"],
      ["shell", "wm", "dismiss-keyguard"],
    ]) {
      try {
        await Bun.spawn([this.adbPath, ...args], { stdout: "ignore", stderr: "ignore" }).exited
      } catch {
        // phone prep is best-effort
      }
    }
  }

  private spawn(): void {
    this.state = "running"
    this.startedAt = Date.now()
    this.proc = Bun.spawn([this.scrcpyPath, ...buildArgs(this.config)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    this.onEvent({ kind: "started" })
    this.watch(this.proc.stdout as ReadableStream)
    this.watch(this.proc.stderr as ReadableStream)
    this.proc.exited.then((code) => this.onExit(code))
  }

  private async watch(stream: ReadableStream): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ""
    for await (const chunk of stream) {
      buf += decoder.decode(chunk)
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.includes("Camera disconnected")) this.onEvent({ kind: "camera-evicted" })
        if (line.includes("Device disconnected")) this.onEvent({ kind: "device-lost" })
      }
    }
  }

  private async onExit(code: number | null): Promise<void> {
    if (this.state !== "running") return
    this.onEvent({ kind: "exited", code })
    this.attempt += 1
    this.state = "restarting"
    this.onEvent({ kind: "restarting", attempt: this.attempt })
    await new Promise((r) => setTimeout(r, this.restartDelayMs))
    if (this.state !== "restarting") return // stopped during backoff
    await this.prepPhone()
    this.spawn()
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test tests/runner.test.ts`
Expected: PASS (2 tests). Also run `bun test` — all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/scrcpy/runner.ts tests/ && git commit -m "feat: stream runner with event classification and auto-restart"
```

---

### Task 5: Setup screen

**Files:**
- Create: `src/ui/setup.tsx`
- Modify: `src/index.tsx` (render Setup instead of placeholder)

**Interfaces:**
- Consumes: `CameraInfo`, `SinkInfo`, `probeCameras`, `probeSinks` from `src/scrcpy/probe.ts`; `StreamConfig`, `buildArgs`, `loadConfig` from `src/config.ts`.
- Produces: `function Setup(props: { onStart: (c: StreamConfig) => void }): JSX.Element` — later consumed by `src/app.tsx` (Task 6).

- [ ] **Step 1: Implement `src/ui/setup.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { SelectOption } from "@opentui/core"
import { buildArgs, loadConfig, type StreamConfig } from "../config"
import { probeCameras, probeSinks, type CameraInfo, type SinkInfo } from "../scrcpy/probe"

const FIELDS = ["camera", "size", "fps", "zoom", "bitrate", "sink"] as const
type Field = (typeof FIELDS)[number]

export function Setup(props: { onStart: (c: StreamConfig) => void }) {
  const [cameras, setCameras] = useState<CameraInfo[] | null>(null)
  const [sinks, setSinks] = useState<SinkInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<StreamConfig | null>(null)
  const [field, setField] = useState<Field>("camera")

  useEffect(() => {
    Promise.all([probeCameras(), probeSinks(), loadConfig()])
      .then(([cams, sk, cfg]) => {
        if (cams.length === 0) {
          setError("No cameras found — is the phone plugged in with USB debugging on?")
          return
        }
        setCameras(cams)
        setSinks(sk)
        const validCam = cams.find((c) => c.id === cfg.cameraId) ?? cams[0]
        const sink = sk.find((s) => s.path === cfg.sink)?.path ?? sk[0]?.path ?? cfg.sink
        setConfig({ ...cfg, cameraId: validCam.id, sink })
      })
      .catch((e) => setError(`Probe failed: ${e.message} — is scrcpy installed?`))
  }, [])

  useKeyboard((key) => {
    if (key.name === "tab") {
      setField((f) => FIELDS[(FIELDS.indexOf(f) + 1) % FIELDS.length])
    }
    if (key.name === "return" && config) props.onStart(config)
  })

  if (error) {
    return (
      <box style={{ border: true, padding: 1, flexDirection: "column" }}>
        <text fg="red">{error}</text>
        <text fg="#888">Fix and restart. USB debugging: Settings → Developer options.</text>
      </box>
    )
  }
  if (!cameras || !config) return <text>Probing phone cameras…</text>

  const cam = cameras.find((c) => c.id === config.cameraId)!
  const camOptions: SelectOption[] = cameras.map((c) => ({
    name: `${c.id}: ${c.facing} ${c.maxSize}`,
    description: c.zoomRange ? `zoom ${c.zoomRange[0]}–${c.zoomRange[1]}` : "",
    value: c.id,
  }))
  const sizeOptions: SelectOption[] = cam.sizes.map((s) => ({ name: s, description: "", value: s }))
  const fpsOptions: SelectOption[] = cam.fps.map((f) => ({ name: String(f), description: "", value: String(f) }))
  const sinkOptions: SelectOption[] =
    sinks.length > 0
      ? sinks.map((s) => ({ name: s.path, description: s.label, value: s.path }))
      : [{ name: "none found", description: "load v4l2loopback first", value: config.sink }]

  return (
    <box style={{ border: true, padding: 1, flexDirection: "column", gap: 1 }} title="android-cam-tui — setup">
      {sinks.length === 0 && (
        <text fg="yellow">
          No v4l2loopback sink. Run: sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"
        </text>
      )}
      <box title={`camera${field === "camera" ? " *" : ""}`} style={{ border: true, height: 6 }}>
        <select
          focused={field === "camera"}
          options={camOptions}
          onChange={(_, o) => {
            const next = cameras.find((c) => c.id === o.value)!
            setConfig({
              ...config,
              cameraId: next.id,
              size: next.sizes.includes(config.size) ? config.size : next.sizes[0],
              fps: next.fps.includes(config.fps) ? config.fps : next.fps[next.fps.length - 1],
              zoom: null,
            })
          }}
        />
      </box>
      <box title={`size${field === "size" ? " *" : ""}`} style={{ border: true, height: 6 }}>
        <select
          focused={field === "size"}
          options={sizeOptions}
          onChange={(_, o) => setConfig({ ...config, size: String(o.value) })}
        />
      </box>
      <box title={`fps${field === "fps" ? " *" : ""}`} style={{ border: true, height: 5 }}>
        <select
          focused={field === "fps"}
          options={fpsOptions}
          onChange={(_, o) => setConfig({ ...config, fps: Number(o.value) })}
        />
      </box>
      <box title={`zoom (blank = default)${field === "zoom" ? " *" : ""}`} style={{ border: true, height: 3 }}>
        <input
          focused={field === "zoom"}
          placeholder={cam.zoomRange ? `${cam.zoomRange[0]}–${cam.zoomRange[1]}, e.g. 0.6` : "n/a"}
          onInput={(v: string) => setConfig({ ...config, zoom: v.trim() === "" ? null : Number(v) })}
        />
      </box>
      <box title={`bitrate${field === "bitrate" ? " *" : ""}`} style={{ border: true, height: 3 }}>
        <input
          focused={field === "bitrate"}
          placeholder={config.bitrate}
          onInput={(v: string) => setConfig({ ...config, bitrate: v.trim() || "16M" })}
        />
      </box>
      <box title={`sink${field === "sink" ? " *" : ""}`} style={{ border: true, height: 4 }}>
        <select
          focused={field === "sink"}
          options={sinkOptions}
          onChange={(_, o) => setConfig({ ...config, sink: String(o.value) })}
        />
      </box>
      <text fg="#888">scrcpy {buildArgs(config).join(" ")}</text>
      <text fg="cyan">Tab: next field · Enter: start stream</text>
    </box>
  )
}
```

- [ ] **Step 2: Wire into `src/index.tsx`**

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Setup } from "./ui/setup"

const renderer = await createCliRenderer()
createRoot(renderer).render(<Setup onStart={(c) => console.log("start", c)} />)
```

- [ ] **Step 3: Manual smoke test (phone plugged in, unlocked)**

Run: `bun run src/index.tsx`
Expected: form shows 4 real cameras for the S23, sizes update when camera changes, command preview line matches selections, Tab cycles fields, `Ctrl+C` exits. With phone unplugged: red error panel with USB-debugging hint.

- [ ] **Step 4: Commit**

```bash
git add src/ui/setup.tsx src/index.tsx && git commit -m "feat: setup screen with live device probing"
```

---

### Task 6: Dashboard screen and app wiring

**Files:**
- Create: `src/ui/dashboard.tsx`, `src/app.tsx`
- Modify: `src/index.tsx`

**Interfaces:**
- Consumes: `Setup` from Task 5; `StreamRunner`, `StreamEvent` from Task 4; `saveConfig`, `StreamConfig` from Task 3; `CameraInfo`, `probeCameras` from Task 2.
- Produces: `App()` root component; zoom presets cycle `[null, 0.6, 1, 3]` clipped to camera's zoomRange; camera cycle across probed camera ids.

- [ ] **Step 1: Implement `src/ui/dashboard.tsx`**

```tsx
import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { StreamConfig } from "../config"
import type { RunnerState, StreamEvent } from "../scrcpy/runner"

export interface LogLine {
  at: string
  msg: string
}

export function eventToLog(e: StreamEvent): string {
  switch (e.kind) {
    case "started":
      return "stream started"
    case "camera-evicted":
      return "camera evicted (phone locked or camera in use — unlock phone)"
    case "device-lost":
      return "device disconnected"
    case "exited":
      return `scrcpy exited (code ${e.code})`
    case "restarting":
      return `restarting (attempt ${e.attempt})…`
  }
}

export function Dashboard(props: {
  config: StreamConfig
  state: RunnerState
  startedAt: number | null
  log: LogLine[]
  onZoomCycle: () => void
  onCameraCycle: () => void
  onRestart: () => void
  onStop: () => void
  onQuit: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useKeyboard((key) => {
    if (key.name === "z") props.onZoomCycle()
    if (key.name === "l") props.onCameraCycle()
    if (key.name === "r") props.onRestart()
    if (key.name === "s") props.onStop()
    if (key.name === "q") props.onQuit()
  })

  const uptime = props.startedAt && props.state === "running" ? Math.floor((now - props.startedAt) / 1000) : 0
  const drops = props.log.filter((l) => l.msg.startsWith("restarting")).length
  const stateColor = props.state === "running" ? "green" : props.state === "restarting" ? "yellow" : "red"

  return (
    <box style={{ border: true, padding: 1, flexDirection: "column", gap: 1 }} title="android-cam-tui — dashboard">
      <box style={{ flexDirection: "row", gap: 3 }}>
        <text fg={stateColor}>{props.state.toUpperCase()}</text>
        <text>up {Math.floor(uptime / 60)}m{uptime % 60}s</text>
        <text>drops {drops}</text>
      </box>
      <text fg="#888">
        cam {props.config.cameraId} · {props.config.size}@{props.config.fps} · {props.config.bitrate} · zoom{" "}
        {props.config.zoom ?? "auto"} · {props.config.sink}
      </text>
      <box title="events" style={{ border: true, flexDirection: "column", height: 12 }}>
        {props.log.slice(-10).map((l, i) => (
          <text key={i} fg="#aaa">
            {l.at} {l.msg}
          </text>
        ))}
      </box>
      <text fg="cyan">z: zoom · l: camera · r: restart · s: stop → setup · q: quit</text>
    </box>
  )
}
```

- [ ] **Step 2: Implement `src/app.tsx`**

```tsx
import { useCallback, useRef, useState } from "react"
import { saveConfig, type StreamConfig } from "./config"
import { probeCameras, type CameraInfo } from "./scrcpy/probe"
import { StreamRunner, type StreamEvent } from "./scrcpy/runner"
import { Dashboard, eventToLog, type LogLine } from "./ui/dashboard"
import { Setup } from "./ui/setup"

const ZOOM_PRESETS = [null, 0.6, 1, 3] as const

export function App(props: { onQuit: () => void }) {
  const [screen, setScreen] = useState<"setup" | "dashboard">("setup")
  const [config, setConfig] = useState<StreamConfig | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [, bump] = useState(0) // re-render on runner state changes
  const camerasRef = useRef<CameraInfo[]>([])
  const runnerRef = useRef<StreamRunner | null>(null)

  const pushEvent = useCallback((e: StreamEvent) => {
    const at = new Date().toTimeString().slice(0, 8)
    setLog((l) => [...l.slice(-50), { at, msg: eventToLog(e) }])
    bump((n) => n + 1)
  }, [])

  const start = useCallback(
    async (c: StreamConfig) => {
      setConfig(c)
      setScreen("dashboard")
      void saveConfig(c)
      camerasRef.current = await probeCameras()
      runnerRef.current = new StreamRunner({ onEvent: pushEvent })
      await runnerRef.current.start(c)
      bump((n) => n + 1)
    },
    [pushEvent],
  )

  const applyConfig = useCallback(async (next: StreamConfig) => {
    setConfig(next)
    void saveConfig(next)
    await runnerRef.current?.restart(next)
    bump((n) => n + 1)
  }, [])

  if (screen === "setup" || !config) return <Setup onStart={start} />

  const runner = runnerRef.current!
  return (
    <Dashboard
      config={config}
      state={runner.state}
      startedAt={runner.startedAt}
      log={log}
      onZoomCycle={() => {
        const cam = camerasRef.current.find((c) => c.id === config.cameraId)
        const usable = ZOOM_PRESETS.filter(
          (z) => z === null || (cam?.zoomRange && z >= cam.zoomRange[0] && z <= cam.zoomRange[1]),
        )
        const idx = usable.indexOf(config.zoom as (typeof usable)[number])
        void applyConfig({ ...config, zoom: usable[(idx + 1) % usable.length] })
      }}
      onCameraCycle={() => {
        const cams = camerasRef.current
        if (cams.length < 2) return
        const idx = cams.findIndex((c) => c.id === config.cameraId)
        const next = cams[(idx + 1) % cams.length]
        void applyConfig({
          ...config,
          cameraId: next.id,
          size: next.sizes.includes(config.size) ? config.size : next.sizes[0],
          fps: next.fps.includes(config.fps) ? config.fps : next.fps[next.fps.length - 1],
          zoom: null,
        })
      }}
      onRestart={() => void applyConfig(config)}
      onStop={() => {
        void runnerRef.current?.stop()
        runnerRef.current = null
        setLog([])
        setScreen("setup")
      }}
      onQuit={() => {
        void runnerRef.current?.stop().then(props.onQuit)
      }}
    />
  )
}
```

- [ ] **Step 3: Rewrite `src/index.tsx` entry**

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./app"

const renderer = await createCliRenderer()
createRoot(renderer).render(
  <App
    onQuit={() => {
      renderer.destroy()
      process.exit(0)
    }}
  />,
)
```

- [ ] **Step 4: Full test suite still green**

Run: `bun test`
Expected: PASS, all suites.

- [ ] **Step 5: Manual smoke test (phone plugged in, unlocked)**

Run: `bun run src/index.tsx`
Expected walkthrough: setup form → Enter → dashboard RUNNING with uptime ticking → check `v4l2-ctl -d /dev/video3 --get-fmt-video` in another shell shows selected resolution → press `z` (stream restarts ~3 s, zoom applied) → lock phone → event log shows "camera evicted…unlock phone" + restarting attempts → unlock phone → RUNNING again → `s` back to setup → `q` quits cleanly, terminal restored.

- [ ] **Step 6: Commit**

```bash
git add src/ && git commit -m "feat: dashboard with live status, hotkeys, and app wiring"
```

---

### Task 7: README and run script

**Files:**
- Create: `README.md`
- Modify: `package.json` (add `"start": "bun run src/index.tsx"` script)

**Interfaces:**
- Consumes: everything; user-facing docs only.

- [ ] **Step 1: Add start script to package.json**

In `package.json`, add:

```json
"scripts": {
  "start": "bun run src/index.tsx"
}
```

- [ ] **Step 2: Write README.md**

````markdown
# android-cam-tui

Terminal UI for using an Android phone as a Linux webcam via
[scrcpy](https://github.com/Genymobile/scrcpy) and v4l2loopback.

Probes your phone's real cameras (lenses, resolutions, fps, zoom ranges),
streams the one you pick into a virtual webcam device, and supervises the
stream — auto-restarting when Android evicts the camera (phone locked,
face unlock, camera app opened).

## Requirements

- Linux with `v4l2loopback` (`sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Cam"`)
- `scrcpy` ≥ 2.2, `adb`, `v4l2-ctl` on PATH
- Bun
- Phone: USB debugging enabled, plugged in, **unlocked** (Android kills
  camera access for adb clients when the keyguard engages)

## Run

```bash
bun install
bun start
```

Setup screen: pick camera/size/fps/zoom/bitrate/sink (all probed live),
Enter to start. Dashboard: `z` cycle zoom presets, `l` cycle camera,
`r` restart, `s` back to setup, `q` quit.

Last-used config persists at `~/.config/android-cam-tui/config.json`.
````

- [ ] **Step 3: Verify start script**

Run: `timeout 3 bun start; echo "exit $?"`
Expected: TUI renders, exit 124.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json && git commit -m "docs: README and start script"
```
