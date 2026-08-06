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
