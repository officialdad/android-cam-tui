export const ORIENTATIONS = ["0", "90", "180", "270", "flip0", "flip90", "flip180", "flip270"] as const
/** Centered crop to a target aspect: scrcpy's --crop on that path, an ffmpeg crop filter on the companion path. */
export const ASPECTS = ["native", "16:9", "4:3", "1:1"] as const

export interface StreamConfig {
  cameraId: string
  size: string
  fps: number
  /** Rates like 120/240 live in a separate camera capture session and need the flag. */
  highSpeed: boolean
  bitrate: string
  zoom: number | null
  /** Camera flash held on as a fill light — set at capture start, so toggling restarts. */
  torch: boolean
  sink: string
  serial: string | null
  /**
   * Which stream path this phone needs. Derived from its API level by `reconcile()` and
   * never trusted from the saved file — a config outlives the phone it was written for.
   */
  backend: "scrcpy" | "companion"
  orientation: (typeof ORIENTATIONS)[number]
  /** Applied before orientation on both backends, matching scrcpy's --crop semantics. */
  aspect: (typeof ASPECTS)[number]
  v4l2Buffer: number
}

export const DEFAULT_CONFIG: StreamConfig = {
  cameraId: "0",
  size: "1920x1080",
  fps: 30,
  highSpeed: false,
  bitrate: "16M",
  zoom: null,
  torch: false,
  sink: "/dev/video3",
  serial: null,
  backend: "scrcpy",
  orientation: "0",
  aspect: "native",
  v4l2Buffer: 0,
}

export const CONFIG_PATH = `${process.env.HOME}/.config/android-cam-tui/config.json`

/**
 * Centered crop of `size` to a target aspect, as scrcpy's W:H:X:Y — or null when there is
 * nothing to crop (native, or the size already has that aspect, e.g. 16:9 on 1920x1080).
 * Everything is rounded down to even: encoders reject odd dimensions, and standard camera
 * sizes only produce odd *offsets* (854x480 to 1:1 puts x at 187), so offsets get it too.
 */
export function cropFor(size: string, aspect: StreamConfig["aspect"]): string | null {
  if (aspect === "native") return null
  const [w, h] = size.split("x").map(Number)
  const [num, den] = aspect.split(":").map(Number)
  const even = (v: number) => Math.floor(v / 2) * 2
  const cw = even(Math.min(w, (h * num) / den))
  const ch = even(Math.min(h, (w * den) / num))
  if (cw === w && ch === h) return null
  return `${cw}:${ch}:${even((w - cw) / 2)}:${even((h - ch) / 2)}`
}

export function buildArgs(c: StreamConfig): string[] {
  const args = [
    "--video-source=camera",
    `--camera-id=${c.cameraId}`,
    `--camera-size=${c.size}`,
    `--camera-fps=${c.fps}`,
    `--video-bit-rate=${c.bitrate}`,
    `--v4l2-sink=${c.sink}`,
    "--no-window",
    "--stay-awake",
    "--no-audio",
  ]
  const crop = cropFor(c.size, c.aspect)
  if (crop) args.push(`--crop=${crop}`)
  if (c.highSpeed) args.push("--camera-high-speed")
  if (c.zoom !== null) args.push(`--camera-zoom=${c.zoom}`)
  if (c.torch) args.push("--camera-torch")
  if (c.serial !== null) args.push("-s", c.serial)
  if (c.orientation !== "0") args.push(`--capture-orientation=${c.orientation}`)
  if (c.v4l2Buffer > 0) args.push(`--v4l2-buffer=${c.v4l2Buffer}`)
  return args
}

export async function loadConfig(path = CONFIG_PATH): Promise<StreamConfig> {
  try {
    const data = await Bun.file(path).json()
    return { ...DEFAULT_CONFIG, ...data }
  } catch {
    return DEFAULT_CONFIG
  }
}

export async function saveConfig(c: StreamConfig, path = CONFIG_PATH): Promise<void> {
  await Bun.write(path, JSON.stringify(c, null, 2)) // Bun.write creates parent dirs
}
