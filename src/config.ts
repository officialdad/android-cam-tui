export interface StreamConfig {
  cameraId: string
  size: string
  fps: number
  bitrate: string
  zoom: number | null
  sink: string
}

export const DEFAULT_CONFIG: StreamConfig = {
  cameraId: "0",
  size: "1920x1080",
  fps: 30,
  bitrate: "16M",
  zoom: null,
  sink: "/dev/video3",
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
  if (c.zoom !== null) args.push(`--camera-zoom=${c.zoom}`)
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
