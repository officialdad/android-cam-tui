export interface CameraInfo {
  id: string
  facing: "back" | "front" | "external"
  maxSize: string
  fps: number[]
  zoomRange: [number, number] | null
  sizes: string[]
  /** Size -> frame rates reachable only via `--camera-high-speed`. Usually 120/240. */
  highSpeed: Record<string, number[]>
}

export interface SinkInfo {
  label: string
  path: string
}

const CAM_RE =
  /--camera-id=(\d+)\s+\((back|front|external), (\d+x\d+), fps=\{([\d, ]+)\}(?:, zoom-range=\[([\d.]+), ([\d.]+)\])?\)/

export function parseCameras(text: string): CameraInfo[] {
  const cams: CameraInfo[] = []
  let current: CameraInfo | null = null
  let inHighSpeed = false
  for (const line of text.split("\n")) {
    const m = line.match(CAM_RE)
    if (m) {
      current = {
        id: m[1],
        facing: m[2] as CameraInfo["facing"],
        maxSize: m[3],
        fps: m[4].split(",").map((s) => Number(s.trim())),
        zoomRange: m[5] ? [Number(m[5]), Number(m[6])] : null,
        sizes: [],
        highSpeed: {},
      }
      cams.push(current)
      inHighSpeed = false
      continue
    }
    if (/High speed capture/.test(line)) {
      inHighSpeed = true
      continue
    }
    // High-speed entries carry their own rates: "- 1280x720 (fps={120, 240})". The
    // camera-level fps list does not include them, so they are kept per size.
    const size = line.match(/^\s+- (\d+x\d+)\s*(?:\(fps=\{([\d, ]+)\}\))?\s*$/)
    if (!size || !current) continue
    if (inHighSpeed) {
      if (size[2]) current.highSpeed[size[1]] = size[2].split(",").map((s) => Number(s.trim()))
    } else {
      current.sizes.push(size[1])
    }
  }
  return cams
}

export function parseSinks(text: string): SinkInfo[] {
  const sinks: SinkInfo[] = []
  const blocks = text.split(/\n(?=\S)/)
  for (const block of blocks) {
    const header = block.match(/^(.+?) \(platform:v4l2loopback[^)]*\):/)
    const dev = block.match(/^\s+(\/dev\/video\d+)/m)
    if (header && dev) sinks.push({ label: header[1], path: dev[1] })
  }
  return sinks
}

export function cameraArgs(serial?: string | null): string[] {
  return serial ? ["-s", serial, "--list-camera-sizes"] : ["--list-camera-sizes"]
}

export async function probeCameras(
  scrcpyPath = "scrcpy",
  serial?: string | null,
): Promise<CameraInfo[]> {
  let proc: Bun.Subprocess
  try {
    proc = Bun.spawn([scrcpyPath, ...cameraArgs(serial)], { stderr: "pipe", stdout: "pipe" })
  } catch {
    throw new Error(`${scrcpyPath} not found — is scrcpy installed and on PATH?`)
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  await proc.exited
  return parseCameras(out + "\n" + err)
}

export async function probeSinks(): Promise<SinkInfo[]> {
  let proc: Bun.Subprocess
  try {
    proc = Bun.spawn(["v4l2-ctl", "--list-devices"], { stdout: "pipe", stderr: "ignore" })
  } catch {
    return [] // no v4l2-ctl — the doctor reports that as its own check
  }
  const out = await new Response(proc.stdout as ReadableStream).text()
  await proc.exited
  return parseSinks(out)
}
