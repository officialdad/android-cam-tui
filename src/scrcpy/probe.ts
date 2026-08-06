export interface CameraInfo {
  id: string
  facing: "back" | "front" | "external"
  maxSize: string
  fps: number[]
  zoomRange: [number, number] | null
  sizes: string[]
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
      }
      cams.push(current)
      inHighSpeed = false
      continue
    }
    if (/High speed capture/.test(line)) {
      inHighSpeed = true
      continue
    }
    const size = line.match(/^\s+- (\d+x\d+)\s*$/)
    if (size && current && !inHighSpeed) current.sizes.push(size[1])
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

export async function probeCameras(scrcpyPath = "scrcpy"): Promise<CameraInfo[]> {
  const proc = Bun.spawn([scrcpyPath, "--list-camera-sizes"], { stderr: "pipe", stdout: "pipe" })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return parseCameras(out + "\n" + err)
}

export async function probeSinks(): Promise<SinkInfo[]> {
  const proc = Bun.spawn(["v4l2-ctl", "--list-devices"], { stdout: "pipe", stderr: "ignore" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return parseSinks(out)
}
