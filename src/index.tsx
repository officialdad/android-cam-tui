#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./app"

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "android-cam-tui [--start] [--doctor]\n\n" +
      "  --start   skip setup, stream the last-used config\n" +
      "  --doctor  check every runtime dependency and exit",
  )
  process.exit(0)
}

if (process.argv.includes("--doctor")) {
  const { checks, probeEnv } = await import("./doctor")
  const list = checks(await probeEnv())
  for (const c of list) {
    const tag = c.ok ? "ok  " : c.level === "block" ? "FAIL" : "warn"
    console.log(`${tag}  ${c.id}${c.ok ? "" : `: ${c.detail}`}`)
    if (!c.ok) for (const line of c.fix) console.log(`        ${line}`)
  }
  process.exit(list.some((c) => c.level === "block" && !c.ok) ? 1 : 0)
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
