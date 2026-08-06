import { useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { SelectOption } from "@opentui/core"

const optValue = (o: SelectOption) => String(o.value ?? o.name)

/** Bordered select with `/`-to-filter (substring, case-insensitive). Controlled: no copy of `value`. */
export function FilteredSelect(props: {
  title: string
  focused: boolean
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  onCaptureChange?: (capturing: boolean) => void
}) {
  const [query, setQuery] = useState("")
  const [filtering, setFiltering] = useState(false)
  // Mirrors `filtering` for the key handler. Keystrokes can arrive faster than React
  // re-renders (key repeat, paste), and the handler's `filtering` closure would still
  // read false — swallowing every character after the opening `/`. The ref is current
  // on the very next keystroke; the state copy exists only to drive rendering.
  const filteringRef = useRef(false)

  const setMode = (on: boolean) => {
    filteringRef.current = on
    setFiltering(on)
    props.onCaptureChange?.(on)
  }

  useKeyboard((key) => {
    // useKeyboard is global: every mounted widget sees every key.
    if (!props.focused) return
    if (!filteringRef.current) {
      if (key.sequence === "/") setMode(true)
      // Enter leaves filter mode with the query still applied; Escape is the way back out.
      else if (key.name === "escape") setQuery("")
      return
    }
    if (key.name === "escape") {
      setQuery("")
      return setMode(false)
    }
    if (key.name === "return") return setMode(false)
    if (key.name === "backspace") return setQuery((q) => q.slice(0, -1))
    if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") {
      const c = key.sequence
      setQuery((q) => q + c)
    }
  })

  const q = query.toLowerCase()
  const shown = q ? props.options.filter((o) => o.name.toLowerCase().includes(q)) : props.options
  // Filtering never calls onChange: an out-of-view value just falls back to row 0 visually.
  const index = Math.max(
    0,
    shown.findIndex((o) => optValue(o) === props.value),
  )

  return (
    <box
      title={filtering || query ? `${props.title} ─ /${query}  ${shown.length}/${props.options.length}` : props.title}
      style={{ border: true, flexGrow: 1, borderColor: props.focused ? "cyan" : undefined }}
    >
      {shown.length === 0 ? (
        <text fg="#888">no match</text>
      ) : (
        <select
          style={{ flexGrow: 1 }}
          // Descriptions cost a second line per row; only pay it when there are any.
          showDescription={props.options.some((o) => o.description)}
          // Unfocused while typing, else the select eats j/k as movement and fires onChange.
          focused={props.focused && !filtering}
          options={shown}
          selectedIndex={index}
          onChange={(_, o) => o && props.onChange(optValue(o))}
        />
      )}
    </box>
  )
}

const BAR = 12 // cells, end caps included

/** One-line left/right picker. Stack several inside a box. */
export function Stepper(props: {
  label: string
  focused: boolean
  options: string[]
  index: number
  onChange: (index: number) => void
  bar?: boolean
  /** Show only the current value with a position counter, for option sets too wide to lay out. */
  compact?: boolean
  labelWidth?: number
}) {
  // Parent stays authoritative — this only carries the index across a burst of keys that
  // arrive before React re-renders (key repeat, a multi-byte read). Stepping off `props.index`
  // alone makes every key in the burst compute the same "+1" and advance a single step.
  const idxRef = useRef(props.index)
  idxRef.current = props.index

  const step = (delta: number) => {
    const next = Math.min(props.options.length - 1, Math.max(0, idxRef.current + delta))
    idxRef.current = next
    props.onChange(next)
  }

  useKeyboard((key) => {
    if (!props.focused) return
    if (key.name === "left") step(-1)
    if (key.name === "right") step(1)
  })

  const label = props.label.padEnd(props.labelWidth ?? 8)
  const fg = props.focused ? "cyan" : undefined

  if (props.compact) {
    return (
      <text>
        {label}
        <span fg={fg}>{`‹ ${props.options[props.index] ?? ""} ›`}</span>
        <span fg="#888">{`  ${props.index + 1}/${props.options.length}`}</span>
      </text>
    )
  }

  if (props.bar) {
    const track = BAR - 2
    const dot = props.options.length < 2 ? 0 : Math.round((props.index / (props.options.length - 1)) * (track - 1))
    return (
      <text>
        {label}
        <span fg={fg}>{`├${"─".repeat(dot)}●${"─".repeat(track - 1 - dot)}┤`}</span>
        {`  ${props.options[props.index] ?? ""}`}
      </text>
    )
  }

  return (
    <text>
      {label}
      {props.options.flatMap((o, i) => [
        i > 0 ? " " : "",
        i === props.index ? (
          <span key={i} fg={fg}>{`‹${o}›`}</span>
        ) : (
          o
        ),
      ])}
    </text>
  )
}
