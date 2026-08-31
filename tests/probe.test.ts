import { describe, expect, test } from "bun:test"
import { cameraArgs, parseCameras, parseSinks } from "../src/scrcpy/probe"

// Captured verbatim from `scrcpy 3.3.4 --list-camera-sizes` against a Galaxy S23
// (SM-S911B, Android 16). The fixture this replaced was written by hand and used a
// `fps={...}` syntax no scrcpy has ever emitted, so the parser matched it and nothing
// else. Every parser fixture here is a real capture — never transcribe one from a doc.
const camText = await Bun.file(new URL("./fixtures/list-camera-sizes.txt", import.meta.url)).text()
const v4l2Text = await Bun.file(new URL("./fixtures/v4l2-devices.txt", import.meta.url)).text()

describe("parseCameras", () => {
  const cams = parseCameras(camText)

  test("finds all four cameras", () => {
    expect(cams.map((c) => c.id)).toEqual(["0", "1", "2", "3"])
  })

  test("parses facing and the bracketed fps list", () => {
    expect(cams[0].facing).toBe("back")
    expect(cams[0].maxSize).toBe("4080x3060")
    expect(cams[0].fps).toEqual([10, 15, 24, 26, 27, 30])
    expect(cams[1].facing).toBe("front")
    expect(cams[1].fps).toEqual([10, 15, 24, 30])
  })

  test("leaves zoomRange null — no released scrcpy prints zoom-range", () => {
    expect(cams.every((c) => c.zoomRange === null)).toBe(true)
  })

  test("attaches normal sizes, excludes high-speed section", () => {
    expect(cams[0].sizes).toContain("2560x1440")
    expect(cams[0].sizes).toContain("4080x3060")
    // 1280x720 appears in both normal and high-speed lists; it must appear once
    expect(cams[0].sizes.filter((s) => s === "1280x720")).toEqual(["1280x720"])
    expect(cams[3].sizes).toContain("3392x2544")
  })

  test("keeps high-speed sizes with their own rates, not the camera-level ones", () => {
    expect(cams[0].highSpeed).toEqual({
      "1280x720": [120, 240],
      "1920x1080": [120, 240],
      "1920x824": [120, 240],
    })
    expect(cams[1].highSpeed["1280x720"]).toEqual([120])
  })
})

// `--camera-zoom` and the `zoom-range=` it needs are documented on upstream master and
// absent from every released scrcpy, so no capture can cover this yet. Synthetic on
// purpose, and the only synthetic camera text in the suite.
describe("parseCameras on the unreleased zoom-range syntax", () => {
  const cams = parseCameras(
    "List of cameras:\n" +
      "    --camera-id=0    (back, 4080x3060, fps=[24, 30], zoom-range=[0.6, 10])\n" +
      "        - 1920x1080\n",
  )

  test("reads the optional zoom range when scrcpy starts emitting it", () => {
    expect(cams).toHaveLength(1)
    expect(cams[0].zoomRange).toEqual([0.6, 10])
    expect(cams[0].fps).toEqual([24, 30])
    expect(cams[0].sizes).toEqual(["1920x1080"])
  })
})

describe("cameraArgs", () => {
  test("no serial keeps the single-device argv unchanged", () => {
    expect(cameraArgs()).toEqual(["--list-camera-sizes"])
    expect(cameraArgs(null)).toEqual(["--list-camera-sizes"])
    expect(cameraArgs("")).toEqual(["--list-camera-sizes"])
  })

  test("serial adds -s", () => {
    expect(cameraArgs("192.168.1.5:5555")).toEqual([
      "-s",
      "192.168.1.5:5555",
      "--list-camera-sizes",
    ])
  })
})

describe("parseSinks", () => {
  test("keeps only v4l2loopback devices", () => {
    expect(parseSinks(v4l2Text)).toEqual([{ label: "Phone Cam", path: "/dev/video3" }])
  })
})
