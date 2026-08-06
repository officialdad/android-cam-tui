// Renders the setup screen against fixture data so the layout can be checked
// without a phone attached. `bun run demo`
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type { Env } from "../doctor"
import type { DeviceInfo } from "../scrcpy/devices"
import type { CameraInfo, SinkInfo } from "../scrcpy/probe"
import { Setup } from "./setup"

const SIZES = [
  "4000x3000", "3840x2160", "2560x1440", "1920x1440", "1920x1080", "1600x1200",
  "1440x1080", "1280x960", "1280x720", "1024x768", "960x720", "800x600",
  "720x480", "640x480", "352x288", "320x240", "176x144",
]

const CAMERAS: CameraInfo[] = [
  { id: "0", facing: "back", maxSize: "4000x3000", fps: [24, 30, 60], zoomRange: [0.5, 10], sizes: SIZES, highSpeed: { "1280x720": [120, 240], "1920x1080": [120] } },
  { id: "1", facing: "front", maxSize: "3264x2448", fps: [30], zoomRange: null, sizes: SIZES.slice(2), highSpeed: {} },
  { id: "2", facing: "back", maxSize: "4000x3000", fps: [30, 60], zoomRange: [1, 8], sizes: SIZES.slice(1), highSpeed: {} },
]

const SINKS: SinkInfo[] = [{ label: "Phone Cam", path: "/dev/video3" }]

const DEVICES: DeviceInfo[] = [
  { serial: "RFCW10PK5MF", model: "SM_S911B", wireless: false, state: "device" },
  { serial: "192.168.1.42:5555", model: "SM_S911B", wireless: true, state: "device" },
]

const renderer = await createCliRenderer()
createRoot(renderer).render(
  <Setup
    probes={{
      cameras: async () => CAMERAS,
      env: async (): Promise<Env> => ({
        scrcpy: "/usr/bin/scrcpy",
        adb: "/usr/bin/adb",
        v4l2ctl: "/usr/bin/v4l2-ctl",
        player: "/usr/bin/mpv",
        scrcpyVersion: [4, 1],
        sinks: SINKS,
        devices: DEVICES,
        distro: "arch",
      }),
    }}
    onStart={() => {
      renderer.destroy()
      process.exit(0)
    }}
  />,
)
