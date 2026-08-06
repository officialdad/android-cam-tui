import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { StreamConfig } from "../config"
import type { RunnerState, StreamEvent } from "../scrcpy/runner"

export interface LogLine {
  at: string
  msg: string
}

export function eventToLog(e: StreamEvent): string {
  switch (e.kind) {
    case "started":
      return "stream started"
    case "camera-evicted":
      return "camera evicted (phone locked or camera in use — unlock phone)"
    case "device-lost":
      return "device disconnected"
    case "exited":
      return `scrcpy exited (code ${e.code})${e.reason ? ` — ${e.reason}` : ""}`
    case "restarting":
      return `restarting (attempt ${e.attempt})…`
    case "gave-up":
      return `gave up after ${e.attempts} attempts — fix the cause above, then r to retry`
  }
}

export function Dashboard(props: {
  config: StreamConfig
  state: RunnerState
  startedAt: number | null
  log: LogLine[]
  onZoomCycle: () => void
  onCameraCycle: () => void
  onTorchToggle: () => void
  onPreview: () => string
  onRestart: () => void
  onStop: () => void
  onQuit: () => void
}) {
  const [now, setNow] = useState(Date.now())
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useKeyboard((key) => {
    if (key.name === "z") props.onZoomCycle()
    if (key.name === "l") props.onCameraCycle()
    if (key.name === "t") props.onTorchToggle()
    if (key.name === "p") setNotice(props.onPreview())
    if (key.name === "r") props.onRestart()
    if (key.name === "s") props.onStop()
    if (key.name === "q") props.onQuit()
  })

  const uptime = props.startedAt && props.state === "running" ? Math.floor((now - props.startedAt) / 1000) : 0
  const drops = props.log.filter((l) => l.msg.startsWith("restarting")).length
  const stateColor = props.state === "running" ? "green" : props.state === "restarting" ? "yellow" : "red"

  const fields: [string, string][] = [
    ["camera", props.config.cameraId],
    ["size", props.config.size],
    ["fps", props.config.highSpeed ? `${props.config.fps} hs` : String(props.config.fps)],
    ["bitrate", props.config.bitrate],
    ["zoom", props.config.zoom === null ? "auto" : `${props.config.zoom}x`],
    ["torch", props.config.torch ? "on" : "off"],
    ["sink", props.config.sink],
  ]

  return (
    <box style={{ border: true, padding: 1, flexDirection: "column", gap: 1 }} title="android-cam-tui — dashboard">
      <box style={{ flexDirection: "row", gap: 3 }}>
        <text fg={stateColor}>● {props.state.toUpperCase()}</text>
        <text>up {Math.floor(uptime / 60)}m{uptime % 60}s</text>
        <text>drops {drops}</text>
      </box>
      <box style={{ flexDirection: "row", gap: 1, flexGrow: 1 }}>
        <box title="stream" style={{ border: true, flexDirection: "column", width: 26 }}>
          {fields.map(([k, v]) => (
            <text key={k} fg="#aaa">
              {k.padEnd(9)}
              {v}
            </text>
          ))}
        </box>
        <scrollbox title="events" style={{ border: true, flexGrow: 1 }} stickyScroll stickyStart="bottom">
          {props.log.map((l, i) => (
            <text key={i} fg="#aaa">
              {l.at} {l.msg}
            </text>
          ))}
        </scrollbox>
      </box>
      {notice && <text fg="#888">{notice}</text>}
      <text fg="cyan">z: zoom · l: camera · t: torch · p: preview · r: restart · s: stop → setup · q: quit</text>
    </box>
  )
}
