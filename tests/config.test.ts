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
