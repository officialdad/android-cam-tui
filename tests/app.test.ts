import { describe, expect, test } from "bun:test"
import { autoStartConfig } from "../src/app"
import { COMPANION_CAM } from "../src/companion"
import { DEFAULT_CONFIG } from "../src/config"
import { MIN_SDK } from "../src/doctor"
import type { DeviceInfo } from "../src/scrcpy/devices"

const device = (sdk?: number): DeviceInfo => ({
  serial: "abc123",
  model: "Test",
  wireless: false,
  state: "device",
  sdk,
})

describe("autoStartConfig", () => {
  // A config saved during a scrcpy session (DEFAULT_CONFIG: 1920x1080@30) must not reach
  // the companion dashboard untouched — the APK ignores it and compiles in 1280x720@30.
  test("snaps size/fps/highSpeed to COMPANION_CAM on a pre-MIN_SDK phone", () => {
    const cfg = { ...DEFAULT_CONFIG, size: "1920x1080", fps: 240, highSpeed: true }
    const result = autoStartConfig(cfg, device(MIN_SDK - 1))
    expect(result.backend).toBe("companion")
    expect(result.size).toBe(COMPANION_CAM.maxSize)
    expect(result.fps).toBe(COMPANION_CAM.fps[0])
    expect(result.highSpeed).toBe(false)
    expect(result.serial).toBe("abc123")
  })

  test("leaves size/fps/highSpeed alone on a scrcpy-capable phone", () => {
    const cfg = { ...DEFAULT_CONFIG, size: "1920x1080", fps: 240, highSpeed: true }
    const result = autoStartConfig(cfg, device(MIN_SDK))
    expect(result.backend).toBe("scrcpy")
    expect(result.size).toBe("1920x1080")
    expect(result.fps).toBe(240)
    expect(result.highSpeed).toBe(true)
  })

  test("no device attached keeps the saved config and its serial, picks scrcpy", () => {
    const cfg = { ...DEFAULT_CONFIG, serial: "old-serial" }
    const result = autoStartConfig(cfg, undefined)
    expect(result.backend).toBe("scrcpy")
    expect(result.serial).toBe("old-serial")
    expect(result.size).toBe(DEFAULT_CONFIG.size)
  })
})
