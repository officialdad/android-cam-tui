import type { CameraInfo } from "./scrcpy/probe"

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
