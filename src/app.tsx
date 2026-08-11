import { useCallback, useEffect, useRef, useState } from "react"
import { COMPANION_CAM, probeCompanionCams, sendExtras, serviceExtras } from "./companion"
import { loadConfig, saveConfig, type StreamConfig } from "./config"
import { backendFor } from "./doctor"
import { openPreview } from "./preview"
import { listDevices, type DeviceInfo } from "./scrcpy/devices"
import { probeCameras, type CameraInfo } from "./scrcpy/probe"
import { StreamRunner, type StreamEvent } from "./scrcpy/runner"
import { Dashboard, eventToLog, type LogLine } from "./ui/dashboard"
import { nextStop, reconcile, Setup, suggestedRotation, zoomStops } from "./ui/setup"

/**
 * What `--start` must hand to `start()` for the phone actually attached. `--start` skips
 * the setup screen, so nothing has run `reconcile()` — and a config saved during a scrcpy
 * session can name a camera, size and fps this phone's APK does not offer. Snapping them
 * here by hand would re-derive reconcile's job and still leave cameraId and zoom stale,
 * so the companion branch routes through `reconcile()` itself — against the dumpsys-probed
 * cameras when the caller has them, else the COMPANION_CAM fallback. `sinks: []` preserves
 * the saved sink. Exported so the snap is testable without rendering the app.
 */
export function autoStartConfig(
  cfg: StreamConfig,
  dev: DeviceInfo | undefined,
  cams: CameraInfo[] = [COMPANION_CAM],
): StreamConfig {
  const next = { ...cfg, serial: dev?.serial ?? cfg.serial }
  const backend = backendFor(dev?.sdk)
  return backend === "companion" ? reconcile(next, cams, [], dev?.sdk) : { ...next, backend }
}

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
        // scrcpy's camera list must be probed *before* the stream holds the camera; the
        // companion probe is the reverse — dump() only answers a running service, which
        // `prepPhone()` (inside runner.start) guarantees, and it never opens the camera.
        if (c.backend !== "companion") camerasRef.current = await probeCameras("scrcpy", c.serial)
        const runner = new StreamRunner({ onEvent: pushEvent })
        await runner.start(c)
        if (c.backend === "companion")
          camerasRef.current = (await probeCompanionCams(c.serial)) ?? [COMPANION_CAM]
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

  // `--start` skips the setup screen with the last-used config. Nothing has reconciled it,
  // so the backend is re-derived here — a config written for one phone must not pick the
  // wrong stream path for another. A config the phone can no longer satisfy just fails the
  // probe, and start() already falls back to setup.
  useEffect(() => {
    if (!props.autoStart) return
    void (async () => {
      const cfg = await loadConfig()
      const devices = await listDevices()
      const dev = devices.find((d) => d.serial === cfg.serial) ?? devices.find((d) => d.state === "device")
      // The probe starts the service itself, so it works before the runner does; without
      // it a saved front-camera config would be snapped back to the fallback's camera "0".
      const cams =
        backendFor(dev?.sdk) === "companion" ? ((await probeCompanionCams(dev?.serial ?? cfg.serial)) ?? undefined) : undefined
      await start(autoStartConfig(cfg, dev, cams))
    })()
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
        // The same stops the setup screen offers — a second list here made 0.8x pickable
        // in setup and unreachable with `z`, and dropped a saved 0.8 to auto on first press.
        const cam = camerasRef.current.find((c) => c.id === config.cameraId)
        void applyConfig({ ...config, zoom: nextStop(zoomStops(cam?.zoomRange ?? null), config.zoom) })
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
          orientation: suggestedRotation(next) ?? config.orientation,
        })
      }}
      onTorchToggle={() => {
        const next = { ...config, torch: !config.torch }
        // Companion torch applies mid-stream: the service reads a re-run start intent's
        // torch extra on the live capture session, so no restart — scrcpy has no such
        // channel and pays the restart applyConfig brings.
        if (config.backend === "companion") {
          setConfig(next)
          void saveConfig(next)
          sendExtras(config.serial, serviceExtras(next)).catch((e) =>
            pushLog(`error: ${e instanceof Error ? e.message : String(e)}`),
          )
        } else void applyConfig(next)
      }}
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
