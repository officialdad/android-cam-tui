/**
 * scrcpy runs with --no-window, so nothing shows what actually reaches the sink.
 * Open whichever player is already installed on the box rather than pulling in a
 * decoder: the frames are already a v4l2 device, every one of these can read it.
 */
const PLAYERS = (sink: string) => [
  ["ffplay", "-loglevel", "error", "-window_title", `preview ${sink}`, "-f", "v4l2", "-i", sink],
  ["mpv", `--title=preview ${sink}`, `av://v4l2:${sink}`],
  ["vlc", `v4l2://${sink}`],
]

/** Detached on purpose: the preview window outlives a stream restart, user closes it. */
export function openPreview(sink: string): string {
  for (const cmd of PLAYERS(sink)) {
    if (!Bun.which(cmd[0])) continue
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })
    return `preview opened with ${cmd[0]}`
  }
  return "no preview player found — install ffmpeg (ffplay), mpv or vlc"
}
