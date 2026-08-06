import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return <text>android-cam-tui</text>
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
