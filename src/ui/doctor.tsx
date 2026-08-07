import { useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { copyToClipboard } from "../clipboard"
import { fixScript, type Check } from "../doctor"

/**
 * Presentational: it renders whatever failed and offers a re-check. All probing
 * lives in Setup, which owns the Env and decides whether this screen appears.
 */
export function Doctor(props: { checks: Check[]; onRecheck: () => void; busy?: boolean }) {
  // `props.busy` is one render behind the handler closure, so two fast `r` presses both
  // read `false` and launch concurrent preflights. Same rule as `capturing`/`idxRef`:
  // mirror the prop into a ref and set it on the keystroke itself.
  const busyRef = useRef(false)
  busyRef.current = props.busy ?? false
  const [copied, setCopied] = useState<string | null>(null)
  // Read inside the handler closure, which is one render behind — same rule as `busyRef`.
  const checksRef = useRef(props.checks)
  checksRef.current = props.checks

  useKeyboard((key) => {
    if (key.name === "r" && !busyRef.current) {
      busyRef.current = true
      props.onRecheck()
    }
    if (key.name === "c") setCopied(copyToClipboard(fixScript(checksRef.current)))
  })

  const failed = props.checks.filter((c) => !c.ok)
  return (
    <box
      style={{ border: true, padding: 1, flexDirection: "column", height: "100%" }}
      title="android-cam-tui — missing dependencies"
    >
      {/* A bare machine fails enough checks to need ~29 rows. Without a viewport that
          clips, opentui overdraws the overflow on top of the lines above it and the whole
          screen becomes unreadable — which is exactly the 80x24 case this screen exists
          for. The scrollbox bounds the content; `height: 100%` above bounds the box. */}
      <scrollbox focused style={{ flexGrow: 1, flexShrink: 1 }} contentOptions={{ gap: 1 }}>
        {failed.map((c) => (
          <box key={c.id} style={{ flexDirection: "column" }}>
            <text fg={c.level === "block" ? "red" : "yellow"}>{c.detail}</text>
            {c.fix.map((line) => (
              <text key={line} fg="#888">{`  ${line}`}</text>
            ))}
          </box>
        ))}
      </scrollbox>
      {/* The renderer holds mouse tracking, so the terminal's own selection is intercepted
          and none of the above can be dragged out — which defeats a screen whose whole job
          is handing over commands. `c` puts them on the clipboard instead. */}
      <text fg={copied ? "green" : "cyan"}>
        {props.busy ? "re-checking…" : (copied ?? "↑↓ scroll · c copy · r re-check · ctrl-c quit")}
      </text>
    </box>
  )
}
