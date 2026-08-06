import { describe, expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
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
 * `env` is read fresh on every probe, so a test can heal the environment between the
 * mount and an `r`. The first probe is held behind a gate until we are inside `act`:
 * the mount effect fires immediately and React warns about updates that land outside it.
 */
async function render(env: () => Env, cams: CameraInfo[], width = 80, height = 24) {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const probes = {
    cameras: async () => cams,
    env: async () => {
      await gate
      return env()
    },
  }
  const t = await testRender(<Setup onStart={() => {}} probes={probes} />, { width, height })
  await act(async () => {
    release()
    await new Promise((r) => setTimeout(r, 60))
    await t.flush()
  })
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
      await new Promise((r) => setTimeout(r, 60))
      await t.flush()
    })

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
})
