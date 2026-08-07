/**
 * The renderer holds mouse tracking, so the terminal's own click-drag selection never
 * reaches the terminal and the doctor's commands cannot be dragged out. Shell out to
 * whichever clipboard tool the session already has rather than pulling in a binding —
 * same shape as `preview.ts`, which picks a player the same way.
 */
const TOOLS = [
  ["wl-copy"], // wayland
  ["xclip", "-selection", "clipboard"], // x11
  ["xsel", "--clipboard", "--input"], // x11, older boxes
]

/**
 * Detached on purpose: an X11 selection lives in the process that owns it, so `xclip`
 * forks and stays resident to serve the paste. Awaiting it would hang until the clipboard
 * is next overwritten.
 */
export function copyToClipboard(text: string): string {
  for (const cmd of TOOLS) {
    if (!Bun.which(cmd[0])) continue
    try {
      Bun.spawn(cmd, { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" })
    } catch {
      continue // present on PATH but unrunnable — try the next one
    }
    return `copied with ${cmd[0]} — paste it into a shell after quitting`
  }
  return "no clipboard tool — install wl-clipboard (wayland) or xclip (x11), or run --doctor"
}
