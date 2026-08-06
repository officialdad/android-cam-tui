import { useCallback, useEffect, useRef, useState } from "react"
import { loadConfig, saveConfig, type StreamConfig } from "./config"
import { openPreview } from "./preview"
import { probeCameras, type CameraInfo } from "./scrcpy/probe"
import { StreamRunner, type StreamEvent } from "./scrcpy/runner"
import { Dashboard, eventToLog, type LogLine } from "./ui/dashboard"
import { Setup } from "./ui/setup"

const ZOOM_PRESETS = [null, 0.6, 1, 3] as const

export function App(props: { onQuit: () => void; autoStart?: boolean }) {
  const [screen, setScreen] = useState<"setup" | "dashboard" | "starting">(
    props.autoStart ? "starting" : "setup",
  )
  const [config, setConfig] = useState<StreamConfig | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [, bump] = useState(0) // re-render on runner state changes
  const camerasRef = useRef<CameraInfo[]>([])
  const runnerRef = useRef<StreamRunner | null>(null)
  const startingRef = useRef(false)

  const pushLog = useCallback((msg: string) => {
    const at = new Date().toTimeString().slice(0, 8)
    setLog((l) => [...l.slice(-50), { at, msg }])
  }, [])

  const pushEvent = useCallback(
    (e: StreamEvent) => {
      pushLog(eventToLog(e))
      bump((n) => n + 1)
    },
    [pushLog],
  )

  const start = useCallback(
    async (c: StreamConfig) => {
      if (startingRef.current || runnerRef.current) return
      startingRef.current = true
      void saveConfig(c)
      try {
        camerasRef.current = await probeCameras("scrcpy", c.serial)
        const runner = new StreamRunner({ onEvent: pushEvent })
        await runner.start(c)
        runnerRef.current = runner
        setConfig(c)
        setScreen("dashboard")
      } catch (e) {
        pushLog(`error: ${e instanceof Error ? e.message : String(e)}`)
        setScreen("setup")
        startingRef.current = false
      }
      bump((n) => n + 1)
    },
    [pushEvent, pushLog],
  )

  // `--start` skips the setup screen with the last-used config. A config the phone can
  // no longer satisfy just fails the probe, and start() already falls back to setup.
  useEffect(() => {
    if (props.autoStart) void loadConfig().then(start)
  }, [props.autoStart, start])

  const applyConfig = useCallback(
    async (next: StreamConfig) => {
      setConfig(next)
      void saveConfig(next)
      try {
        await runnerRef.current?.restart(next)
      } catch (e) {
        pushLog(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
      bump((n) => n + 1)
    },
    [pushLog],
  )

  if (screen === "starting") return <text>starting from saved config…</text>
  if (screen === "setup" || !config) return <Setup onStart={start} />

  const runner = runnerRef.current
  if (!runner) return <text>starting…</text>
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
      onTorchToggle={() => void applyConfig({ ...config, torch: !config.torch })}
      onPreview={() => openPreview(config.sink)}
      onRestart={() => void applyConfig(config)}
      onStop={() => {
        void runnerRef.current?.stop().then(() => {
          startingRef.current = false
        })
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
