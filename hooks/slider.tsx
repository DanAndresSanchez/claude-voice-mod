import type { ClientModule } from 'claude-code'

// The speed slider in the bar above the prompt: drag the knob (or click it and
// use the arrow keys); the new speed is posted when the drag ends.
export const MIN = 120
export const MAX = 400
const STEP = 10

type Props = { wpm: number }
type State = { drag?: number }

const clamp = (wpm: number) => Math.min(MAX, Math.max(MIN, Math.round(wpm / STEP) * STEP))

const Slider: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const shown = surface.state?.drag ?? clamp(props.wpm || 180)
  const track = Math.max(8, surface.columns - 8)
  const at = Math.round(((shown - MIN) / (MAX - MIN)) * (track - 1))
  const toWpm = (x: number) => clamp(MIN + (x / (track - 1)) * (MAX - MIN))

  surface.onPointer(e => {
    if (e.type === 'up') {
      if (surface.state?.drag !== undefined) surface.post({ wpm: surface.state.drag })
      surface.setState({})
    } else if ((e.type === 'down' || e.type === 'move') && e.button === 'left') {
      surface.setState({ drag: toWpm(e.fine?.x ?? e.x) })
    }
  })
  surface.onKey(e => {
    const by = e.key === 'right' ? STEP : e.key === 'left' ? -STEP : 0
    if (by) surface.post({ wpm: clamp(shown + by) })
  })

  // One monospaced line that never wraps: the desktop's own font would make
  // the track wider than its cells and push the knob onto a second row.
  return (
    <Text mono wrap="truncate-end">
      <Text color="claude">{'━'.repeat(at)}●</Text>
      <Text dimColor>{'─'.repeat(track - 1 - at)}</Text> {String(shown).padStart(3)}wpm
    </Text>
  )
}

export default Slider
