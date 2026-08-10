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
