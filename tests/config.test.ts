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

  test("appends the high-speed flag only when set", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, fps: 240, highSpeed: true })).toContain("--camera-high-speed")
    expect(buildArgs(DEFAULT_CONFIG)).not.toContain("--camera-high-speed")
  })

  test("appends zoom only when set", () => {
    expect(buildArgs({ ...DEFAULT_CONFIG, zoom: 0.6 })).toContain("--camera-zoom=0.6")
    expect(buildArgs(DEFAULT_CONFIG).join(" ")).not.toContain("--camera-zoom")
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
