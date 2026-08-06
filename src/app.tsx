import { useCallback, useRef, useState } from "react"
import { saveConfig, type StreamConfig } from "./config"
import { probeCameras, type CameraInfo } from "./scrcpy/probe"
import { StreamRunner, type StreamEvent } from "./scrcpy/runner"
import { Dashboard, eventToLog, type LogLine } from "./ui/dashboard"
import { Setup } from "./ui/setup"

const ZOOM_PRESETS = [null, 0.6, 1, 3] as const

export function App(props: { onQuit: () => void }) {
  const [screen, setScreen] = useState<"setup" | "dashboard">("setup")
  const [config, setConfig] = useState<StreamConfig | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [, bump] = useState(0) // re-render on runner state changes
  const camerasRef = useRef<CameraInfo[]>([])
  const runnerRef = useRef<StreamRunner | null>(null)

  const pushEvent = useCallback((e: StreamEvent) => {
    const at = new Date().toTimeString().slice(0, 8)
    setLog((l) => [...l.slice(-50), { at, msg: eventToLog(e) }])
    bump((n) => n + 1)
  }, [])

  const start = useCallback(
    async (c: StreamConfig) => {
      setConfig(c)
      setScreen("dashboard")
      void saveConfig(c)
      camerasRef.current = await probeCameras()
      runnerRef.current = new StreamRunner({ onEvent: pushEvent })
      await runnerRef.current.start(c)
      bump((n) => n + 1)
    },
    [pushEvent],
  )

  const applyConfig = useCallback(async (next: StreamConfig) => {
    setConfig(next)
    void saveConfig(next)
    await runnerRef.current?.restart(next)
    bump((n) => n + 1)
  }, [])

  if (screen === "setup" || !config) return <Setup onStart={start} />

  const runner = runnerRef.current!
  return (
    <Dashboard
      config={config}
      state={runner.state}
      startedAt={runner.startedAt}
      log={log}
      onZoomCycle={() => {
        const cam = camerasRef.current.find((c) => c.id === config.cameraId)
        const usable = ZOOM_PRESETS.filter(
          (z) => z === null || (cam?.zoomRange && z >= cam.zoomRange[0] && z <= cam.zoomRange[1]),
        )
        const idx = usable.indexOf(config.zoom as (typeof usable)[number])
        void applyConfig({ ...config, zoom: usable[(idx + 1) % usable.length] })
      }}
      onCameraCycle={() => {
        const cams = camerasRef.current
        if (cams.length < 2) return
        const idx = cams.findIndex((c) => c.id === config.cameraId)
        const next = cams[(idx + 1) % cams.length]
        void applyConfig({
          ...config,
          cameraId: next.id,
          size: next.sizes.includes(config.size) ? config.size : next.sizes[0],
          fps: next.fps.includes(config.fps) ? config.fps : next.fps[next.fps.length - 1],
          zoom: null,
        })
      }}
      onRestart={() => void applyConfig(config)}
      onStop={() => {
        void runnerRef.current?.stop()
        runnerRef.current = null
        setLog([])
        setScreen("setup")
      }}
      onQuit={() => {
        void runnerRef.current?.stop().then(props.onQuit)
      }}
    />
  )
}
