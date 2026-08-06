import { describe, expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { Stepper } from "../src/ui/widgets"

// Keystrokes can arrive faster than React re-renders (key repeat, a multi-byte read).
// A Stepper that steps off `props.index` alone sees the same stale value for every key
// in the burst, so all of them compute the same "+1" and it advances a single notch.
describe("Stepper", () => {
  function Harness() {
    const [i, setI] = useState(0)
    return <Stepper label="zoom" focused options={["a", "b", "c", "d", "e"]} index={i} onChange={setI} />
  }

  test("a burst of arrows advances one step per key", async () => {
    const t = await testRender(<Harness />, { width: 40, height: 3 })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
      await t.flush()
    })

    await act(async () => {
      t.mockInput.pressArrow("right")
      t.mockInput.pressArrow("right")
      t.mockInput.pressArrow("right")
      await t.flush()
    })

    expect(t.captureCharFrame()).toContain("‹d›")
  })

  test("clamps at the end instead of wrapping", async () => {
    const t = await testRender(<Harness />, { width: 40, height: 3 })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
      await t.flush()
    })

    await act(async () => {
      for (let n = 0; n < 8; n++) t.mockInput.pressArrow("right")
      await t.flush()
    })

    expect(t.captureCharFrame()).toContain("‹e›")
  })
})
