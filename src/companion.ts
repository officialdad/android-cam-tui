// Built from github.com/officialdad/android-cam at fcc681d ("feat: camera probe over
// dumpsys, camera selection extra"). sha256
// b8a51d3016daa447ce244b91831582e84d7fcc1049b64d23dbd7da9f5c89a7ac, 16787 bytes. The
// doctor tells users to install this on their phone, so a rebuild updates both lines.
import apk from "./android-cam.apk" with { type: "file" }
import { homedir } from "node:os"
import type { StreamConfig } from "./config"
import type { CameraInfo } from "./scrcpy/probe"
import { adb } from "./scrcpy/devices"

export const PKG = "com.officialdad.androidcam"
export const SOCKET = "android-cam"
/** scrcpy's own default. Only one backend runs at a time, so there is nothing to collide with. */
export const PORT = 27183

/**
 * The old-APK fallback, used only when `probeCompanionCams` gets no answer — an APK from
 * before the dumpsys probe (fcc681d) cannot report its real cameras, and asking scrcpy is
 * the very thing that fails on these phones. Everything here is then a request the phone
 * clamps: sizes survive that (ffmpeg reads the real size off the H.264 SPS), fps must
 * stay the single stop the APK defaults to, because `-r` in `ffmpegArgs` has to match the
 * actual stream rate and a silently clamped fps would corrupt the timing host-side. A
 * probed camera list has no such problem — its fps options are the AE-range upper bounds,
 * which the service honours exactly.
 */
export const COMPANION_CAM: CameraInfo = {
  id: "0",
  facing: "back",
  maxSize: "1920x1080",
  fps: [30],
  // Optimistic, like the sizes: the camera's real max digital zoom is not probeable, but
  // the service clamps to SCALER_AVAILABLE_MAX_DIGITAL_ZOOM, so overshoot just pins there.
  zoomRange: [1, 4],
  sizes: ["1920x1080", "1280x720", "640x480"],
  highSpeed: {},
}

export interface CompanionState {
  installed: boolean
  granted: boolean
}

/**
 * The probe reply: `dumpsys activity service <pkg>/.CamService` routes through the
 * service's own dump(), which prints one line of JSON somewhere in ActivityManager's
 * headers and indentation — take the first `{` to the last `}` on the line containing
 * `"cameras"`. An old APK prints no such line; null means "fall back to COMPANION_CAM".
 * Malformed entries are skipped rather than failing the probe: one bad camera must not
 * take down the picker.
 */
export function parseCompanionProbe(dumpsys: string): CameraInfo[] | null {
  const line = dumpsys.split("\n").find((l) => l.includes('"cameras"'))
  if (!line) return null
  const start = line.indexOf("{")
  const end = line.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const cams: CameraInfo[] = []
    for (const c of JSON.parse(line.slice(start, end + 1)).cameras ?? []) {
      const sizes: string[] = (c.sizes ?? []).filter((s: unknown) => typeof s === "string")
      if (typeof c.id !== "string" || sizes.length === 0) continue // nothing streamable
      // Distinct AE upper bounds, ascending. Offering only uppers is what keeps ffmpeg's
      // `-r` honest: the service picks the range whose upper matches, so a rate from this
      // list is never silently clamped to something else.
      const fps = [...new Set<number>((c.fpsRanges ?? []).map((r: number[]) => r[1]))]
        .filter((f) => Number.isFinite(f) && f > 0)
        .sort((a, b) => a - b)
      cams.push({
        id: c.id,
        facing: c.facing === "front" || c.facing === "external" ? c.facing : "back",
        maxSize: sizes[0], // dump() sorts descending by area
        fps: fps.length > 0 ? [...fps] : [...COMPANION_CAM.fps],
        zoomRange: typeof c.maxZoom === "number" && c.maxZoom > 1 ? [1, c.maxZoom] : null,
        sizes,
        highSpeed: {},
        orientation: typeof c.orientation === "number" ? c.orientation : undefined,
      })
    }
    return cams.length > 0 ? cams : null
  } catch {
    return null
  }
}

/**
 * Probe the phone's real cameras through the running service. Starts it first (idempotent,
 * extras absent so the config is untouched) because dump() only answers a live service —
 * and it may take a beat to come up, hence the poll. The camera itself is not opened:
 * reading characteristics needs no CAMERA grant, so this works even before the permission
 * is granted. Null — adb gone, APK missing or too old to answer — means COMPANION_CAM.
 */
export async function probeCompanionCams(
  serial: string | null,
  adbPath = "adb",
  tries = 10,
): Promise<CameraInfo[] | null> {
  const base = serial ? [adbPath, "-s", serial] : [adbPath]
  try {
    const svc = await adb([...base, "shell", "am", "start-foreground-service", "-n", `${PKG}/.CamService`])
    // Nonzero covers a dead adb or absent device; `Error:` is `am`'s own stdout failure
    // mode (exit 0). Either way there is no service to poll, so don't spend 2s trying.
    if (svc.code !== 0 || /^Error:/m.test(svc.out)) return null
    for (let i = 0; i < tries; i++) {
      const { out } = await adb([...base, "shell", "dumpsys", "activity", "service", `${PKG}/.CamService`])
      const cams = parseCompanionProbe(out)
      if (cams) return cams
      await Bun.sleep(200)
    }
  } catch {
    // fall through — no adb is its own doctor check
  }
  return null
}

/**
 * One `dumpsys package <pkg>` answers both questions, so there is no second adb call.
 * An absent package prints "Unable to find package" and nothing else.
 */
export function parseCompanionState(dumpsys: string): CompanionState {
  const installed = dumpsys.includes(`Package [${PKG}]`)
  return {
    installed,
    granted: installed && /android\.permission\.CAMERA: granted=true/.test(dumpsys),
  }
}

/** /proc/net/unix lists abstract sockets with a leading `@`; a path socket is not ours. */
export function socketReady(procNetUnix: string): boolean {
  return procNetUnix.split("\n").some((line) => line.trimEnd().endsWith(`@${SOCKET}`))
}

/**
 * scrcpy-style bitrate ("16M", "8000K", "8000000") to the plain bits/s the intent extra
 * wants. Anything unparseable falls back to the APK's own default rather than sending 0,
 * which the service would treat as "keep the current config".
 */
export function parseBitrate(b: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(b.trim())
  if (!m) return 8_000_000
  return Math.round(Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : m[2] ? 1e3 : 1))
}

/**
 * The config's ride to the phone: `--ei` extras on the start intent. The socket stays
 * pure H.264 — its client is ffmpeg reading the stream raw, which can neither send a
 * config frame nor tolerate a reply ahead of the Annex-B. The service clamps these to
 * what the camera offers and applies them at the next client connect.
 */
export function serviceExtras(
  c: Pick<StreamConfig, "size" | "fps" | "bitrate" | "zoom" | "cameraId">,
): string[] {
  const [width, height] = c.size.split("x")
  return [
    ...["--ei", "width", width, "--ei", "height", height],
    ...["--ei", "fps", String(c.fps)],
    ...["--ei", "bitrate", String(parseBitrate(c.bitrate))],
    // Always sent, even for "auto": a re-run `am` keeps absent extras at their *previous*
    // values, so dropping the extra after zooming would leave the phone zoomed forever.
    // The service reads ≤100 as off, which is what auto means here (no digital crop).
    ...["--ei", "zoom", String(c.zoom === null ? 100 : Math.round(c.zoom * 100))],
    // String extra — camera2 ids are strings, and an unknown one falls back to the back
    // camera on the phone (clamp, never fail).
    ...["--es", "camera", c.cameraId],
  ]
}

/**
 * Rotation happens here, not on the phone: raw Annex-B has no rotation metadata and
 * Camera2 cannot rotate buffers into the encoder surface, so the phone side would need an
 * OpenGL pass. A transpose is a lossless pixel remap — do it where it is nearly free.
 * Numbers are clockwise, matching scrcpy's --capture-orientation; flip is horizontal,
 * applied before the rotation like scrcpy's flipNNN.
 */
const ROTATE_FILTER: Record<StreamConfig["orientation"], string> = {
  "0": "",
  "90": "transpose=1",
  "180": "transpose=1,transpose=1",
  "270": "transpose=2",
  flip0: "hflip",
  flip90: "hflip,transpose=1",
  flip180: "vflip", // hflip + 180° collapses to a vertical flip
  flip270: "hflip,transpose=2",
}

/**
 * Centered crop to the requested aspect. Expression-based on iw/ih rather than computed
 * from the config: the phone clamps the requested size to what its camera offers and
 * there is no reply channel, so the config's size is not what necessarily arrives —
 * ffmpeg's own view of the decoded stream is. (The scrcpy path computes the numbers
 * instead — `cropFor` in config.ts — because its sizes are exact.) Quoted so the commas
 * inside min() survive the filtergraph parser (the args go through Bun.spawn, no shell
 * to strip them).
 */
const ASPECT_FILTER: Record<StreamConfig["aspect"], string> = {
  native: "",
  "16:9": "crop=w='min(iw,ih*16/9)':h='min(ih,iw*9/16)'",
  "4:3": "crop=w='min(iw,ih*4/3)':h='min(ih,iw*3/4)'",
  "1:1": "crop=w='min(iw,ih)':h='min(iw,ih)'",
}

/**
 * run.sh's invocation plus the host-side filters. The `-r` before `-i` is load-bearing:
 * Annex-B carries no timestamps, so without it ffmpeg guesses a 1200k tbr for the input
 * and drops ~98% of the frames converting down. Do not move it to the output side. `fps`
 * must match what the phone actually streams — see the COMPANION_CAM note on why it is
 * not user-selectable. Filter order: crop first, then rotate — scrcpy applies --crop
 * before --capture-orientation, and the two backends must not disagree about what an
 * aspect means under rotation.
 */
export function ffmpegArgs(
  port: number,
  c: Pick<StreamConfig, "sink" | "fps" | "orientation" | "aspect">,
): string[] {
  const vf = [ASPECT_FILTER[c.aspect], ROTATE_FILTER[c.orientation], "format=yuv420p"]
    .filter(Boolean)
    .join(",")
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-r",
    String(c.fps),
    "-f",
    "h264",
    "-i",
    `tcp://127.0.0.1:${port}`,
    "-fps_mode",
    "passthrough",
    "-vf",
    vf,
    "-f",
    "v4l2",
    c.sink,
  ]
}

/**
 * Tilde, not $HOME expanded: this string goes into a doctor fix line, and the doctor
 * indents those by two inside a bordered box, so an expanded path on a long username
 * blows the 76-column budget and the user pastes a broken command.
 */
export const APK_CACHE = "~/.cache/android-cam-tui/android-cam.apk"

// homedir() rather than a literal `~`: Bun.write would take that at its word and create a
// directory called `~` in the cwd.
const expand = (p: string) => p.replace(/^~/, process.env.HOME ?? homedir())

/**
 * The imported path addresses Bun's embedded filesystem inside a compiled binary, which
 * `adb install` — a subprocess — cannot open. Write the bytes somewhere real first.
 */
export async function materializeApk(dest = APK_CACHE): Promise<string | null> {
  try {
    await Bun.write(expand(dest), Bun.file(apk)) // Bun.write creates parent dirs
    return dest
  } catch {
    return null
  }
}

export async function companionState(serial: string, adbPath = "adb"): Promise<CompanionState> {
  try {
    const { out } = await adb([adbPath, "-s", serial, "shell", "dumpsys", "package", PKG])
    return parseCompanionState(out)
  } catch {
    return { installed: false, granted: false } // no adb — that has its own doctor check
  }
}

/**
 * Forward the port, start the service, wait for its socket. Never starts an activity:
 * `am start-foreground-service` leaves a locked phone locked, and waking it would start
 * face unlock, which opens a camera of its own and pushes the device past the
 * system-wide open-camera limit so our own open is rejected.
 */
export async function prepPhone(
  serial: string | null,
  adbPath = "adb",
  extras: string[] = [],
  tries = 30,
): Promise<void> {
  const base = serial ? [adbPath, "-s", serial] : [adbPath]
  // Idempotent, so it is re-run on every spawn rather than tracked and torn down.
  const fwd = await adb([...base, "forward", `tcp:${PORT}`, `localabstract:${SOCKET}`])
  if (fwd.code !== 0) throw new Error(fwd.out.trim() || "adb forward failed")
  // `am` reports its real failures on stdout with exit code 0: no such subcommand on an
  // Android below 8.0, a SecurityException, a background-start restriction, a package a
  // battery optimiser force-stopped, or a `.CamService` renamed out from under `PKG` by a
  // future APK rebuild. Unread, every one of them becomes the same 6-second timeout below
  // with a camera-permission hint that is wrong in all of them.
  // Extras are the config channel; an old APK ignores them and streams its defaults.
  const svc = await adb([...base, "shell", "am", "start-foreground-service", "-n", `${PKG}/.CamService`, ...extras])
  if (/^Error:/m.test(svc.out)) throw new Error(svc.out.trim())
  // The service binds its socket a beat after the process starts; racing ffmpeg against
  // it just fails.
  for (let i = 0; i < tries; i++) {
    const { out } = await adb([...base, "shell", "cat", "/proc/net/unix"])
    if (socketReady(out)) return
    await Bun.sleep(200)
  }
  throw new Error(
    `Android Cam never listened — grant it the camera: adb shell pm grant ${PKG} android.permission.CAMERA`,
  )
}

/**
 * The forward lives in the adb server, which outlives this process, so left behind it
 * leaves 127.0.0.1:27183 open — anything that connects to it makes the phone open its
 * camera and stream. Best-effort and never throws: `stop()` also runs on teardown paths
 * where the phone is already gone.
 */
export async function unforward(serial: string | null, adbPath = "adb"): Promise<void> {
  const base = serial ? [adbPath, "-s", serial] : [adbPath]
  await adb([...base, "forward", "--remove", `tcp:${PORT}`]).catch(() => undefined)
}
