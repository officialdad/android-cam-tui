export const ORIENTATIONS = ["0", "90", "180", "270", "flip0", "flip90", "flip180", "flip270"] as const

export interface StreamConfig {
  cameraId: string
  size: string
  fps: number
  /** Rates like 120/240 live in a separate camera capture session and need the flag. */
  highSpeed: boolean
  bitrate: string
  zoom: number | null
  sink: string
  serial: string | null
  orientation: (typeof ORIENTATIONS)[number]
  v4l2Buffer: number
}

export const DEFAULT_CONFIG: StreamConfig = {
  cameraId: "0",
  size: "1920x1080",
  fps: 30,
  highSpeed: false,
  bitrate: "16M",
  zoom: null,
  sink: "/dev/video3",
  serial: null,
  orientation: "0",
  v4l2Buffer: 0,
}

export const CONFIG_PATH = `${process.env.HOME}/.config/android-cam-tui/config.json`

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
  if (c.highSpeed) args.push("--camera-high-speed")
  if (c.zoom !== null) args.push(`--camera-zoom=${c.zoom}`)
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
