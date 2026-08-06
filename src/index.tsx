#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./app"

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("android-cam-tui [--start]\n\n  --start  skip setup, stream the last-used config")
  process.exit(0)
}

const renderer = await createCliRenderer()
createRoot(renderer).render(
  <App
    autoStart={process.argv.includes("--start")}
    onQuit={() => {
      renderer.destroy()
      process.exit(0)
    }}
  />,
)
