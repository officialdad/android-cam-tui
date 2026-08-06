import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Setup } from "./ui/setup"

const renderer = await createCliRenderer()
createRoot(renderer).render(<Setup onStart={(c) => console.log("start", c)} />)
