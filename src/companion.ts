import apk from "./android-cam.apk" with { type: "file" }
import type { CameraInfo } from "./scrcpy/probe"
import { adb } from "./scrcpy/devices"

export const PKG = "com.officialdad.androidcam"
export const SOCKET = "android-cam"
/** scrcpy's own default. Only one backend runs at a time, so there is nothing to collide with. */
export const PORT = 27183

/**
 * What the APK actually does, as constants rather than a probe result. Camera, size and
 * fps are compiled into CamService and there is no control channel to change them — and
 * asking scrcpy to list cameras on one of these phones is the very thing that fails, so
 * there is nothing to probe with either.
 */
export const COMPANION_CAM: CameraInfo = {
  id: "0",
  facing: "back",
  maxSize: "1280x720",
  fps: [30],
  zoomRange: null,
  sizes: ["1280x720"],
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
 * run.sh's invocation, verbatim. The `-r` before `-i` is load-bearing: Annex-B carries no
 * timestamps, so without it ffmpeg guesses a 1200k tbr for the input and drops ~98% of the
 * frames converting down. Do not move it to the output side.
 */
export function ffmpegArgs(port: number, sink: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-r",
    String(COMPANION_CAM.fps[0]),
    "-f",
    "h264",
    "-i",
    `tcp://127.0.0.1:${port}`,
    "-fps_mode",
    "passthrough",
    "-vf",
    "format=yuv420p",
    "-f",
    "v4l2",
    sink,
  ]
}

/**
 * Tilde, not $HOME expanded: this string goes into a doctor fix line, and the doctor
 * indents those by two inside a bordered box, so an expanded path on a long username
 * blows the 76-column budget and the user pastes a broken command.
 */
export const APK_CACHE = "~/.cache/android-cam-tui/android-cam.apk"

const expand = (p: string) => p.replace(/^~/, process.env.HOME ?? "~")

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
export async function prepPhone(serial: string | null, adbPath = "adb", tries = 30): Promise<void> {
  const base = serial ? [adbPath, "-s", serial] : [adbPath]
  // Idempotent, so it is re-run on every spawn rather than tracked and torn down.
  const fwd = await adb([...base, "forward", `tcp:${PORT}`, `localabstract:${SOCKET}`])
  if (fwd.code !== 0) throw new Error(fwd.out.trim() || "adb forward failed")
  await adb([...base, "shell", "am", "start-foreground-service", "-n", `${PKG}/.CamService`])
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
