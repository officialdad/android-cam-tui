// Built from github.com/officialdad/android-cam at 6896011 ("feat: digital zoom via a
// `zoom` intent extra"). sha256
// b64ff5f1a15824028289daaa4f8ea7d6b18d9c8420ad49c437d066d697370c95, 16787 bytes. The
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
 * What the APK accepts, as constants rather than a probe result — asking scrcpy to list
 * cameras on one of these phones is the very thing that fails, so there is nothing to
 * probe with. Since 3a5cbd8 the start intent carries size/fps/bitrate extras and the
 * service clamps them to what the camera offers, so the sizes here are requests, not
 * guarantees: a phone that lacks one streams the nearest it has, and the host never
 * learns which (ffmpeg reads the real size off the H.264 SPS, so nothing downstream
 * cares). fps stays a single stop because it is different: `-r` in `ffmpegArgs` must
 * match the actual stream rate, and a silently clamped fps would corrupt the timing
 * host-side. Widening it needs a reply channel the socket deliberately does not have.
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
export function serviceExtras(c: Pick<StreamConfig, "size" | "fps" | "bitrate" | "zoom">): string[] {
  const [width, height] = c.size.split("x")
  return [
    ...["--ei", "width", width, "--ei", "height", height],
    ...["--ei", "fps", String(c.fps)],
    ...["--ei", "bitrate", String(parseBitrate(c.bitrate))],
    // Always sent, even for "auto": a re-run `am` keeps absent extras at their *previous*
    // values, so dropping the extra after zooming would leave the phone zoomed forever.
    // The service reads ≤100 as off, which is what auto means here (no digital crop).
    ...["--ei", "zoom", String(c.zoom === null ? 100 : Math.round(c.zoom * 100))],
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
