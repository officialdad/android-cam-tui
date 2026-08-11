import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config"
import type { CameraInfo, SinkInfo } from "../src/scrcpy/probe"
import {
  bitrateStops,
  camSizes,
  deviceLabel,
  fieldsFor,
  focusLabel,
  focusStops,
  fpsStops,
  nextStop,
  reconcile,
  suggestedRotation,
  zoomStops,
} from "../src/ui/setup"

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

  test("drops a focus beyond the lens or on a camera without one, keeps one inside", () => {
    const probed = [{ ...cams[0], minFocus: 10 }, cams[1]]
    expect(reconcile({ ...DEFAULT_CONFIG, cameraId: "0", focus: 2 }, probed, sinks).focus).toBe(2)
    expect(reconcile({ ...DEFAULT_CONFIG, cameraId: "0", focus: 0 }, probed, sinks).focus).toBe(0) // ∞ is valid
    expect(reconcile({ ...DEFAULT_CONFIG, cameraId: "0", focus: 12 }, probed, sinks).focus).toBeNull()
    // cams[1] reports no minFocus — a fixed-focus lens keeps only autofocus.
    expect(reconcile({ ...DEFAULT_CONFIG, cameraId: "1", focus: 2 }, probed, sinks).focus).toBeNull()
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

  // The companion probe reports SENSOR_ORIENTATION; a camera that fails the snap lands on
  // one whose rotation the user has never seen, so the suggestion applies. A camera that
  // survives keeps whatever the user dialed in.
  test("suggests the rotation only when the camera did not survive the snap", () => {
    const probed: CameraInfo[] = [{ ...cams[1], id: "0", orientation: 270 }]
    const snapped = reconcile({ ...DEFAULT_CONFIG, cameraId: "9", orientation: "90" }, probed, sinks)
    expect(snapped.orientation).toBe("180") // (270 - 90) % 360
    const kept = reconcile({ ...DEFAULT_CONFIG, cameraId: "0", orientation: "90" }, probed, sinks)
    expect(kept.orientation).toBe("90")
  })

  test("preserves the sink when nothing was probed rather than blanking it", () => {
    expect(reconcile({ ...DEFAULT_CONFIG, sink: "/dev/video7" }, cams, []).sink).toBe("/dev/video7")
  })

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

describe("suggestedRotation", () => {
  // Buffers arrive in sensor coordinates; SENSOR_ORIENTATION is the clockwise turn to
  // upright-portrait, and a webcam wants upright-landscape — 90° before that.
  test("maps sensor orientation to the webcam-upright rotation", () => {
    expect(suggestedRotation({ ...cams[0], orientation: 90 })).toBe("0") // typical back
    expect(suggestedRotation({ ...cams[0], orientation: 270 })).toBe("180") // typical front
    expect(suggestedRotation({ ...cams[0], orientation: 0 })).toBe("270")
    expect(suggestedRotation({ ...cams[0], orientation: 180 })).toBe("90")
  })

  test("no probe data, no opinion", () => {
    expect(suggestedRotation(cams[0])).toBeNull()
  })
})

describe("fieldsFor", () => {
  // One menu, both backends. Each drops the one stepper that can do nothing on its path:
  // the v4l2 buffer is a scrcpy flag ffmpeg has no equivalent for, focus a companion
  // intent extra scrcpy has no flag for. fps stays with its single stop: showing it is
  // how the ceiling is visible, like the single camera.
  test("companion drops the buffer, scrcpy drops focus, nothing else differs", () => {
    expect(fieldsFor("companion").filter((f) => f !== "focus") as string[]).toEqual(
      fieldsFor("scrcpy").filter((f) => f !== "buffer"),
    )
    expect(fieldsFor("companion")).toContain("fps")
    expect(fieldsFor("companion")).toContain("focus")
    expect(fieldsFor("companion")).toContain("aspect")
    expect(fieldsFor("companion")).not.toContain("buffer")
  })

  test("the scrcpy path keeps every field but focus", () => {
    expect(fieldsFor("scrcpy")).toContain("bitrate")
    expect(fieldsFor("scrcpy")).toContain("zoom")
    expect(fieldsFor("scrcpy")).toContain("buffer")
    expect(fieldsFor("scrcpy")).toContain("aspect")
    expect(fieldsFor("scrcpy")).not.toContain("focus")
  })
})

describe("focusStops", () => {
  test("autofocus only for a fixed-focus lens or no probe answer", () => {
    expect(focusStops(undefined)).toEqual([null])
    expect(focusStops(0)).toEqual([null])
  })

  test("auto, infinity, presets inside the lens's reach, closing on its minimum", () => {
    const stops = focusStops(10)
    expect(stops[0]).toBeNull()
    expect(stops[1]).toBe(0) // infinity
    expect(stops.at(-1)).toBe(10) // the closest the lens goes
    expect(stops).toContain(2) // 50cm
  })

  test("no duplicate when the lens minimum is also a preset", () => {
    expect(focusStops(5).filter((f) => f === 5)).toHaveLength(1)
  })

  test("labels read as distances, not diopters", () => {
    expect(focusLabel(null)).toBe("auto")
    expect(focusLabel(0)).toBe("∞")
    expect(focusLabel(0.5)).toBe("2m")
    expect(focusLabel(1)).toBe("1m")
    expect(focusLabel(2)).toBe("50cm")
    expect(focusLabel(10)).toBe("10cm")
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
