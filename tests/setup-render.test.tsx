import { describe, expect, mock, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import type { StreamConfig } from "../src/config"
import { checks, type Env } from "../src/doctor"
import type { CameraInfo } from "../src/scrcpy/probe"
import { Setup } from "../src/ui/setup"

const HEALTHY: Env = {
  scrcpy: "/usr/bin/scrcpy",
  adb: "/usr/bin/adb",
  v4l2ctl: "/usr/bin/v4l2-ctl",
  player: "/usr/bin/mpv",
  scrcpyVersion: [4, 1],
  sinks: [{ label: "Phone Cam", path: "/dev/video3" }],
  devices: [{ serial: "R5CT", model: "SM_S911B", wireless: false, state: "device" }],
  distro: "debian",
}

/** A fresh Ubuntu box that just ran the curl installer: nothing else is there yet. */
const BARE: Env = {
  ...HEALTHY,
  scrcpy: null,
  adb: null,
  v4l2ctl: null,
  player: null,
  scrcpyVersion: null,
  sinks: [],
  devices: [],
}

const CAMERAS: CameraInfo[] = [
  { id: "0", facing: "back", maxSize: "1920x1080", fps: [30], zoomRange: null, sizes: ["1920x1080"], highSpeed: {} },
]

/**
 * `t.waitFor`/`t.waitForFrame` only ride the renderer's *already-scheduled* render queue —
 * their loop bails the instant `getSchedulerState()` reports nothing pending, which is true
 * right after `release()`: React hasn't dispatched the update through a real event-loop turn
 * yet, and `preflight`'s own `loadConfig()` is a real fs read those helpers' microtask-only
 * draining can't force to completion either. Both need an actual timer tick, so this polls
 * with one — same shape as the `waitFor` tests/runner.test.ts added in 029778f for the same
 * reason, just checking rendered text instead of an event count.
 *
 * Call this *outside* any wrapping `act(...)`: this renderer defers committing frames to a
 * still-open `act` callback until that callback returns, so a predicate read from inside one
 * never observes the update it's polling for and just burns the full timeout. Keep `act`
 * around the key press alone; poll after it resolves.
 */
async function pollFrame(t: Awaited<ReturnType<typeof testRender>>, pred: (frame: string) => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    await new Promise((r) => setTimeout(r, 5))
    await t.flush()
    const frame = t.captureCharFrame()
    if (pred(frame)) return frame
    if (Date.now() > deadline) throw new Error(`timed out waiting for frame:\n${frame}`)
  }
}

/**
 * `env` is read fresh on every probe, so a test can heal the environment between the
 * mount and an `r`. The first probe is held behind a gate until we are inside `act`:
 * the mount effect fires immediately and React warns about updates that land outside it.
 */
async function render(
  env: () => Env,
  cams: CameraInfo[],
  width = 80,
  height = 24,
  onStart: (c: StreamConfig) => void = () => {},
) {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const probes = {
    cameras: async () => cams,
    env: async () => {
      await gate
      return env()
    },
  }
  const t = await testRender(<Setup onStart={onStart} probes={probes} />, { width, height })
  await act(async () => {
    release()
  })
  await pollFrame(t, (frame) => !frame.includes("Probing phone cameras…"))
  return t
}

/**
 * Every row inside the border, with the frame's own decoration removed: one space of box
 * padding on the left, the scrollbar column on the right. What is left has to be a whole
 * line the component meant to draw. Overdrawn text ("scsudo aptninstallAscrcpy") and
 * lines wrapped mid-path both survive as strings that are in no expected list.
 */
function bodyLines(frame: string): string[] {
  return frame
    .split("\n")
    .filter((l) => l.startsWith("│"))
    .map((l) =>
      l
        .replace(/^│/, "")
        .replace(/│$/, "")
        .trimEnd()
        .replace(/[█▀▄▌▐░▒]+$/, "")
        .trimEnd()
        .replace(/^ /, ""),
    )
    .filter((l) => l.length > 0)
}

describe("Setup → Doctor", () => {
  test("a blocking env renders every block detail and its fix lines", async () => {
    const t = await render(() => BARE, CAMERAS, 80, 44)
    const frame = t.captureCharFrame()

    for (const c of checks(BARE).filter((c) => !c.ok)) {
      expect(frame).toContain(c.detail)
      for (const line of c.fix) expect(frame).toContain(line)
    }
    expect(frame).toContain("r to re-check")
  })

  // The regression test for the 80x24 overdraw: the doctor needs ~29 rows for a bare
  // machine, and an unbounded box drew the overflow on top of the rows above it.
  test("at 80x24 with everything missing, no line is overdrawn or wrapped", async () => {
    const t = await render(() => BARE, CAMERAS)
    const frame = t.captureCharFrame()

    const expected = new Set<string>()
    for (const c of checks(BARE).filter((c) => !c.ok)) {
      expected.add(c.detail)
      for (const line of c.fix) expected.add(`  ${line}`)
    }
    const lines = bodyLines(frame)
    const footer = lines.at(-1)!
    expect(footer).toContain("r to re-check")

    expect(lines.slice(0, -1).filter((l) => !expected.has(l))).toEqual([])
    // …and it actually drew something, so an empty body cannot pass the check above.
    expect(lines).toContain("scrcpy is not on PATH")
    expect(lines).toContain("  sudo apt install scrcpy")
  })

  test("r re-checks and reaches the setup screen once the environment heals", async () => {
    let env = BARE
    const t = await render(() => env, CAMERAS)
    expect(t.captureCharFrame()).toContain("missing dependencies")

    env = HEALTHY
    await act(async () => {
      t.mockInput.pressKey("r")
    })
    await pollFrame(t, (frame) => frame.includes("android-cam-tui — setup"))

    const frame = t.captureCharFrame()
    expect(frame).toContain("android-cam-tui — setup")
    expect(frame).not.toContain("missing dependencies")
  })

  // The design's reason for making the version check a warning: it has to reach the user
  // attached to the `No cameras` symptom, which is a different screen from the setup one.
  test("no cameras on an old scrcpy reports both, with a re-check key", async () => {
    const old: Env = { ...HEALTHY, scrcpyVersion: [2, 1] }
    const t = await render(() => old, [], 80, 44)
    const frame = t.captureCharFrame()

    expect(frame).toContain("no cameras on R5CT")
    expect(frame).toContain("scrcpy 2.1 is too old")
    expect(frame).toContain("r to re-check")
  })

  // Regression for the `refreshEnv()` change in `toggleTransport`: it sets `checkList`
  // from a fresh probe while `config`/`cameras` survive from the earlier healthy preflight,
  // so pressing `w` and losing the phone lands on the doctor screen with `config` still
  // non-null. `goWireless`/`goUsb` are the spawn wrapper around real `adb` calls (see
  // src/scrcpy/devices.ts) and are not injectable through `props.probes`, so they are faked
  // at the module boundary — the same pure/spawner seam CLAUDE.md calls out elsewhere.
  test("Enter on the doctor screen does not start a stream once w lands there", async () => {
    await mock.module("../src/scrcpy/devices", () => ({
      goWireless: async () => "10.0.0.5:5555",
      goUsb: async () => undefined,
    }))
    try {
      let env: Env = HEALTHY
      let started: StreamConfig | null = null
      const t = await render(() => env, CAMERAS, 80, 24, (c) => (started = c))
      expect(t.captureCharFrame()).toContain("android-cam-tui — setup")

      // The phone drops off wifi mid-toggle: the fresh probe behind `w` reports blocking
      // checks while the config picked during the healthy preflight above is untouched.
      env = BARE
      await act(async () => {
        t.mockInput.pressKey("w")
      })
      await pollFrame(t, (frame) => frame.includes("missing dependencies"))

      await act(async () => {
        t.mockInput.pressKey("RETURN")
      })

      expect(started).toBeNull()
    } finally {
      mock.restore()
    }
  })
})
