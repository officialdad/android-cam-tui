import { useKeyboard } from "@opentui/react"
import type { Check } from "../doctor"

/**
 * Presentational: it renders whatever failed and offers a re-check. All probing
 * lives in Setup, which owns the Env and decides whether this screen appears.
 */
export function Doctor(props: { checks: Check[]; onRecheck: () => void; busy?: boolean }) {
  useKeyboard((key) => {
    if (key.name === "r" && !props.busy) props.onRecheck()
  })

  const failed = props.checks.filter((c) => !c.ok)
  return (
    <box
      style={{ border: true, padding: 1, flexDirection: "column", gap: 1 }}
      title="android-cam-tui — missing dependencies"
    >
      {failed.map((c) => (
        <box key={c.id} style={{ flexDirection: "column" }}>
          <text fg={c.level === "block" ? "red" : "yellow"}>{c.detail}</text>
          {c.fix.map((line) => (
            <text key={line} fg="#888">{`  ${line}`}</text>
          ))}
        </box>
      ))}
      <text fg="cyan">{props.busy ? "re-checking…" : "run the commands above, then r to re-check · ctrl-c quit"}</text>
    </box>
  )
}
