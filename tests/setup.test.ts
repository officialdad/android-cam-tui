import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config"
import type { CameraInfo, SinkInfo } from "../src/scrcpy/probe"
import { bitrateStops, camSizes, deviceLabel, fpsStops, nextStop, reconcile, zoomStops } from "../src/ui/setup"

const cams: CameraInfo[] = [
  { id: "0", facing: "back", maxSize: "4080x3060", fps: [24, 30, 60], zoomRange: [0.6, 10], sizes: ["1920x1080", "1280x720"], highSpeed: { "1280x720": [120, 240], "800x600": [240] } },
  { id: "1", facing: "front", maxSize: "4000x3000", fps: [30], zoomRange: null, sizes: ["640x480"], highSpeed: {} },
]

describe("camSizes", () => {
  test("merges high-speed-only sizes in without duplicating shared ones", () => {
    expect(camSizes(cams[0])).toEqual(["1920x1080", "1280x720", "800x600"])
    expect(camSizes(cams[1])).toEqual(["640x480"])
  })
})

describe("fpsStops", () => {
  test("a normal-only size offers just the camera-level rates", () => {
    expect(fpsStops(cams[0], "1920x1080")).toEqual([
      { fps: 24, highSpeed: false },
      { fps: 30, highSpeed: false },
      { fps: 60, highSpeed: false },
    ])
  })

  test("a size in both lists offers both modes", () => {
    expect(fpsStops(cams[0], "1280x720")).toEqual([
      { fps: 24, highSpeed: false },
      { fps: 30, highSpeed: false },
      { fps: 60, highSpeed: false },
      { fps: 120, highSpeed: true },
      { fps: 240, highSpeed: true },
    ])
  })

  test("a high-speed-only size offers no normal rates", () => {
    expect(fpsStops(cams[0], "800x600")).toEqual([{ fps: 240, highSpeed: true }])
  })
})

describe("reconcile", () => {
  const sinks: SinkInfo[] = [{ label: "Phone Cam", path: "/dev/video3" }]

  test("keeps values the selected camera actually supports", () => {
    const got = reconcile({ ...DEFAULT_CONFIG, cameraId: "0", size: "1280x720", fps: 24, zoom: 2 }, cams, sinks)
    expect(got).toMatchObject({ cameraId: "0", size: "1280x720", fps: 24, zoom: 2 })
  })

  test("falls back when the camera does not support the saved size or fps", () => {
    // switching to camera 1: none of these carry over
    const got = reconcile({ ...DEFAULT_CONFIG, cameraId: "1", size: "1920x1080", fps: 60, zoom: 5 }, cams, sinks)
    expect(got).toMatchObject({ cameraId: "1", size: "640x480", fps: 30, zoom: null })
  })

  test("drops a zoom outside the camera's range, keeps one inside", () => {
    expect(reconcile({ ...DEFAULT_CONFIG, cameraId: "0", zoom: 0.5 }, cams, sinks).zoom).toBeNull()
    expect(reconcile({ ...DEFAULT_CONFIG, cameraId: "0", zoom: 10 }, cams, sinks).zoom).toBe(10)
  })

  test("an unknown camera id falls back to the first camera", () => {
    expect(reconcile({ ...DEFAULT_CONFIG, cameraId: "9" }, cams, sinks).cameraId).toBe("0")
  })

  test("keeps a high-speed pair the size supports", () => {
    const got = reconcile({ ...DEFAULT_CONFIG, cameraId: "0", size: "1280x720", fps: 240, highSpeed: true }, cams, sinks)
    expect(got).toMatchObject({ size: "1280x720", fps: 240, highSpeed: true })
  })

  test("a high-speed rate on a size without it falls back to a normal rate", () => {
    const got = reconcile({ ...DEFAULT_CONFIG, cameraId: "0", size: "1920x1080", fps: 240, highSpeed: true }, cams, sinks)
    expect(got).toMatchObject({ size: "1920x1080", fps: 60, highSpeed: false })
  })

  test("a high-speed-only size forces the mode on rather than an unsupported normal rate", () => {
    const got = reconcile({ ...DEFAULT_CONFIG, cameraId: "0", size: "800x600", fps: 30, highSpeed: false }, cams, sinks)
    expect(got).toMatchObject({ size: "800x600", fps: 240, highSpeed: true })
  })

  test("the same number in both modes is not treated as a match", () => {
    const cam: CameraInfo[] = [{ ...cams[0], fps: [30, 120], highSpeed: { "1280x720": [120] } }]
    const got = reconcile({ ...DEFAULT_CONFIG, cameraId: "0", size: "1280x720", fps: 120, highSpeed: true }, cam, sinks)
    expect(got).toMatchObject({ fps: 120, highSpeed: true })
  })

  test("keeps the saved sink when it still exists, else the first probed one", () => {
    expect(reconcile({ ...DEFAULT_CONFIG, sink: "/dev/video3" }, cams, sinks).sink).toBe("/dev/video3")
    expect(reconcile({ ...DEFAULT_CONFIG, sink: "/dev/video9" }, cams, sinks).sink).toBe("/dev/video3")
  })

  test("preserves the sink when nothing was probed rather than blanking it", () => {
    expect(reconcile({ ...DEFAULT_CONFIG, sink: "/dev/video7" }, cams, []).sink).toBe("/dev/video7")
  })
})

describe("deviceLabel", () => {
  test("marks transport, and surfaces a bad state instead of it", () => {
    expect(deviceLabel({ serial: "RFCW10PK5MF", model: "SM_S911B", wireless: false, state: "device" })).toBe(
      "RFCW10PK5MF  SM_S911B  usb",
    )
    expect(deviceLabel({ serial: "192.168.1.42:5555", model: "SM_S911B", wireless: true, state: "device" })).toBe(
      "192.168.1.42:5555  SM_S911B  wifi",
    )
    expect(deviceLabel({ serial: "X1", model: "", wireless: false, state: "unauthorized" })).toBe("X1  unauthorized")
  })
})

describe("nextStop", () => {
  test("the dashboard z key visits every stop the setup screen offers", () => {
    const stops = zoomStops([0.6, 10])
    expect(stops).toContain(0.8)
    expect(nextStop(stops, 0.6)).toBe(0.8) // not 1 — the two lists used to disagree
    expect(nextStop(stops, 10)).toBeNull() // wraps to auto
  })

  test("a value outside the list lands on the first stop", () => {
    expect(nextStop(zoomStops([1, 8]), 0.6)).toBeNull()
  })
})

describe("zoomStops", () => {
  test("auto only when the camera reports no zoom range", () => {
    expect(zoomStops(null)).toEqual([null])
  })

  test("keeps both endpoints and drops presets outside the range", () => {
    const stops = zoomStops([1, 8])
    expect(stops[0]).toBeNull()
    expect(stops[1]).toBe(1)
    expect(stops[stops.length - 1]).toBe(8)
    expect(stops).not.toContain(0.5) // below min
    expect(stops).not.toContain(10) // above max
  })

  test("no duplicate stop when an endpoint is also a preset", () => {
    const stops = zoomStops([0.5, 10])
    expect(stops.filter((z) => z === 0.5)).toHaveLength(1)
    expect(stops.filter((z) => z === 10)).toHaveLength(1)
  })

  test("degenerate range does not produce a duplicate", () => {
    expect(zoomStops([2, 2])).toEqual([null, 2])
  })
})

describe("bitrateStops", () => {
  test("presets unchanged when the current value is one of them", () => {
    expect(bitrateStops("16M")).toEqual(["4M", "8M", "16M", "24M", "32M"])
  })

  test("a saved custom bitrate stays selectable, in numeric order", () => {
    expect(bitrateStops("20M")).toEqual(["4M", "8M", "16M", "20M", "24M", "32M"])
  })
})
