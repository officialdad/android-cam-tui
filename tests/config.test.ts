import { describe, expect, test } from "bun:test"
import { buildArgs, cropFor, DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config"

describe("cropFor", () => {
  test("centers the crop and skips it when there is nothing to cut", () => {
    expect(cropFor("1920x1080", "1:1")).toBe("1080:1080:420:0")
    expect(cropFor("1920x1080", "4:3")).toBe("1440:1080:240:0")
    expect(cropFor("1920x1080", "16:9")).toBeNull() // already 16:9
    expect(cropFor("1920x1080", "native")).toBeNull()
  })

  // Encoders reject odd dimensions, and 854x480 to 1:1 puts the x offset at 187.
  test("rounds sizes and offsets down to even", () => {
    expect(cropFor("854x480", "1:1")).toBe("480:480:186:0")
  })
})

describe("buildArgs", () => {
  test("crops to the aspect, before the capture orientation", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, aspect: "1:1" })).toContain("--crop=1080:1080:420:0")
    expect(buildArgs(DEFAULT_CONFIG).join(" ")).not.toContain("--crop")
  })

  test("builds full flag set", () => {
    expect(buildArgs(DEFAULT_CONFIG)).toEqual([
      "--video-source=camera",
      "--camera-id=0",
      "--camera-size=1920x1080",
      "--camera-fps=30",
      "--video-bit-rate=16M",
      "--v4l2-sink=/dev/video3",
      "--no-window",
      "--no-audio",
    ])
  })

  test("never emits --stay-awake — camera source disables control, and scrcpy dies on the pair", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, torch: true, zoom: 2 }).join(" ")).not.toContain("--stay-awake")
  })

  test("appends the high-speed flag only when set", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, fps: 240, highSpeed: true })).toContain("--camera-high-speed")
    expect(buildArgs(DEFAULT_CONFIG)).not.toContain("--camera-high-speed")
  })

  test("appends zoom only when set", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, zoom: 0.6 })).toContain("--camera-zoom=0.6")
    expect(buildArgs(DEFAULT_CONFIG).join(" ")).not.toContain("--camera-zoom")
  })
})

// scrcpy exits on an unrecognized option before it ever opens the camera, and the runner
// reads that as a dead stream and retries — so an optional flag this build lacks costs the
// whole session, not just the feature.
describe("buildArgs against a probed flag list", () => {
  const OLD = ["--camera-id", "--camera-size", "--camera-fps", "--v4l2-sink"]
  const NEW = [...OLD, "--camera-torch", "--camera-zoom"]

  test("drops torch and zoom when scrcpy does not advertise them", () => {
    const args = buildArgs({ ...DEFAULT_CONFIG, torch: true, zoom: 2 }, OLD).join(" ")
    expect(args).not.toContain("--camera-torch")
    expect(args).not.toContain("--camera-zoom")
  })

  test("emits them once scrcpy does", () => {
    const args = buildArgs({ ...DEFAULT_CONFIG, torch: true, zoom: 2 }, NEW)
    expect(args).toContain("--camera-torch")
    expect(args).toContain("--camera-zoom=2")
  })

  test("never gates a flag that has been there since 3.0", () => {
    const args = buildArgs({ ...DEFAULT_CONFIG, v4l2Buffer: 100, orientation: "90" }, [])
    expect(args).toContain("--v4l2-sink=/dev/video3")
    expect(args).toContain("--v4l2-buffer=100")
    expect(args).toContain("--capture-orientation=90")
    expect(args).toContain("--camera-id=0")
  })

  test("an unprobed null list emits everything, as before", () => {
    const args = buildArgs({ ...DEFAULT_CONFIG, torch: true, zoom: 2 }, null)
    expect(args).toContain("--camera-torch")
    expect(args).toContain("--camera-zoom=2")
  })

  test("appends serial as two elements only when set", () => {
    const args = buildArgs({ ...DEFAULT_CONFIG, serial: "192.168.1.5:5555" })
    expect(args.slice(-2)).toEqual(["-s", "192.168.1.5:5555"])
    expect(buildArgs(DEFAULT_CONFIG)).not.toContain("-s")
  })

  test("appends capture-orientation only when not 0", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, orientation: "270" })).toContain("--capture-orientation=270")
    expect(buildArgs({ ...DEFAULT_CONFIG, orientation: "flip90" })).toContain("--capture-orientation=flip90")
    expect(buildArgs(DEFAULT_CONFIG).join(" ")).not.toContain("--capture-orientation")
  })

  test("appends v4l2-buffer only when above 0", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, v4l2Buffer: 100 })).toContain("--v4l2-buffer=100")
    expect(buildArgs(DEFAULT_CONFIG).join(" ")).not.toContain("--v4l2-buffer")
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

  test("pre-existing config file gains new field defaults", async () => {
    await Bun.write(tmp, JSON.stringify({ cameraId: "1", size: "1280x720", fps: 60, bitrate: "8M", zoom: null, sink: "/dev/video3" }))
    const cfg = await loadConfig(tmp)
    expect(cfg.serial).toBeNull()
    expect(cfg.orientation).toBe("0")
    expect(cfg.v4l2Buffer).toBe(0)
    expect(cfg.cameraId).toBe("1") // on-disk values still win
  })
})
