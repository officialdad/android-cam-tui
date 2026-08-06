import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./app"

const renderer = await createCliRenderer()
createRoot(renderer).render(
  <App
    onQuit={() => {
      renderer.destroy()
      process.exit(0)
    }}
  />,
)
