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
      return `scrcpy exited (code ${e.code})`
    case "restarting":
      return `restarting (attempt ${e.attempt})…`
  }
}

export function Dashboard(props: {
  config: StreamConfig
  state: RunnerState
  startedAt: number | null
  log: LogLine[]
  onZoomCycle: () => void
  onCameraCycle: () => void
  onRestart: () => void
  onStop: () => void
  onQuit: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useKeyboard((key) => {
    if (key.name === "z") props.onZoomCycle()
    if (key.name === "l") props.onCameraCycle()
    if (key.name === "r") props.onRestart()
    if (key.name === "s") props.onStop()
    if (key.name === "q") props.onQuit()
  })

  const uptime = props.startedAt && props.state === "running" ? Math.floor((now - props.startedAt) / 1000) : 0
  const drops = props.log.filter((l) => l.msg.startsWith("restarting")).length
  const stateColor = props.state === "running" ? "green" : props.state === "restarting" ? "yellow" : "red"

  return (
    <box style={{ border: true, padding: 1, flexDirection: "column", gap: 1 }} title="android-cam-tui — dashboard">
      <box style={{ flexDirection: "row", gap: 3 }}>
        <text fg={stateColor}>{props.state.toUpperCase()}</text>
        <text>up {Math.floor(uptime / 60)}m{uptime % 60}s</text>
        <text>drops {drops}</text>
      </box>
      <text fg="#888">
        cam {props.config.cameraId} · {props.config.size}@{props.config.fps} · {props.config.bitrate} · zoom{" "}
        {props.config.zoom ?? "auto"} · {props.config.sink}
      </text>
      <box title="events" style={{ border: true, flexDirection: "column", height: 12 }}>
        {props.log.slice(-10).map((l, i) => (
          <text key={i} fg="#aaa">
            {l.at} {l.msg}
          </text>
        ))}
      </box>
      <text fg="cyan">z: zoom · l: camera · r: restart · s: stop → setup · q: quit</text>
    </box>
  )
}
