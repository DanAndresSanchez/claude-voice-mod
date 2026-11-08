import { atom, memberOf, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import type { Prefs } from '../types'
import { chunk, coreOf, findWord, highlight, parseVoices } from './text'

// One member per message (keyed by its requestId), so a word change redraws
// only the reply being read.
const word = atom({ plugin: 'read-aloud', key: 'word' } as const, null)
const isOn = atom({ plugin: 'read-aloud', key: 'isOn' } as const, true)
const SYSTEM: Prefs = { voice: '', wpm: 0, style: 'color' }
const prefsAtom = atom({ plugin: 'read-aloud', key: 'prefs' } as const, SYSTEM)
const player = atom({ plugin: 'read-aloud', key: 'player' } as const, { isSpeaking: false, canReplay: false })

const DEMO = 'Hi, I am Claude. This is how I sound with these settings.'
const SPEEDS = [
  { value: '0', label: 'System speed' },
  { value: '150', label: 'Slow' },
  { value: '200', label: 'Normal' },
  { value: '240', label: 'Fast' },
  { value: '290', label: 'Faster' },
  { value: '340', label: 'Fastest' },
]
const STYLES = [
  { value: 'color', label: 'Colour' },
  { value: 'colorbold', label: 'Colour and bold' },
  { value: 'box', label: 'Box' },
  { value: 'bold', label: 'Bold' },
  { value: 'italic', label: 'Italic' },
  { value: 'bolditalic', label: 'Bold italic' },
]
// How each style wraps the word. A link only recolours it, so no letter
// changes width and the line never shifts.
const LINK = 'https://read-aloud.invalid'
const MARKS = {
  color: ['[', `](${LINK})`],
  colorbold: ['**[', `](${LINK})**`],
  box: ['`', '`'],
  bold: ['**', '**'],
  italic: ['*', '*'],
  bolditalic: ['***', '***'],
}

// The speed one step slower or faster than `wpm` (0, the system's, counts as 180).
function stepSpeed(wpm: number, by: 1 | -1): number {
  const steps = SPEEDS.slice(1).map(s => Number(s.value))
  const at = wpm || 180
  return (by > 0 ? steps.find(s => s > at) : steps.reverse().find(s => s < at)) ?? wpm
}

// Compiles the WAV-player helper (command engine only) once per source
// version into the user's cache and prints its path.
const build = (root: string) => [
  '/bin/sh',
  '-c',
  `dir="$HOME/Library/Caches/read-aloud"; mkdir -p "$dir"
bin="$dir/speak-$(cksum < "$1" | cut -d' ' -f1)"
if [ ! -x "$bin" ]; then swiftc -O -o "$bin" "$1" 2>"$dir/build.log" || { cat "$dir/build.log" >&2; exit 1; }; fi
echo "$bin"`,
  'sh',
  `${root}/helper/speak.swift`,
]

// One sentence to say, and the reply block it came from.
type Line = { text: string; block: string }

// How a reply block is matched to its message: its first characters.
const headOf = (markdown: string) => markdown.trim().slice(0, 40)

export const register: Register = (on, options) => {
  const backend = String(options.backend ?? 'system')
  const command = String(options.command ?? '')

  let prefs = SYSTEM
  let voices: { value: string; label: string }[] = []
  let queue: Line[] = []
  let generation = 0 // bumped by halt(); a running utterance gives up when it changes
  let current: AsyncIterator<unknown> | undefined
  let wake: (() => void) | undefined
  let streaming = 0 // main-loop responses still arriving
  let reply: Line[] = [] // every sentence of the latest reply, for Read again
  let isStopped = false // the person stopped this reply: say no more of it
  // Each reply block's markdown as streamed so far, and how far speech has got in it.
  const blocks = new Map<string, string>()
  const cursors = new Map<string, number>()
  // Messages drawn so far, by their head: where a block's highlight goes.
  const messages = new Map<string, string>()

  function messageOf(markdown: string): string | undefined {
    const head = headOf(markdown)
    if (head.length < 4) return undefined
    // The latest drawn message that fits: an old reply may share a short head.
    let found: string | undefined
    for (const [drawn, id] of messages) {
      if (drawn.startsWith(head) || head.startsWith(drawn)) found = id
    }
    return found
  }

  function say(lines: Line[]) {
    if (lines.length === 0) return
    queue.push(...lines)
    wake?.()
  }

  function halt() {
    generation += 1
    queue = []
    void current?.return?.() // leaving the stream kills the speaker
  }

  // Stop, and stay quiet for the rest of this reply.
  function stop() {
    isStopped = true
    halt()
  }

  // The latest reply's sentences as it streams; spoken unless stopped.
  function heard(lines: Line[]) {
    reply.push(...lines)
    if (!isStopped) say(lines)
  }

  // Say the latest reply again from its start.
  function replay() {
    halt()
    isStopped = false
    for (const l of reply) cursors.set(l.block, 0)
    say([...reply])
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'read-aloud',
      description: 'Read replies aloud: voice, speed and highlight, or on | off | stop | again | demo',
      argumentHint: '[on|off|stop|again|demo]',
    })
    const saved = (await $.store.get('prefs')) as Partial<Prefs> | undefined
    const style = saved?.style && saved.style in MARKS ? saved.style : 'color'
    prefs = { voice: String(saved?.voice ?? ''), wpm: Number(saved?.wpm ?? 0), style }
    await update($, prefsAtom, () => prefs)
    voices = parseVoices((await $.process.run(['/usr/bin/say', '-v', '?'])).stdout)

    // The speaker: runs for the session's life, one sentence at a time.
    void (async () => {
      let bin = ''
      let lit: string | undefined // the message whose word is marked now
      for (;;) {
        try {
          const line = queue.shift()
          if (line === undefined) {
            await new Promise<void>(resolve => (wake = resolve))
            continue
          }
          const gen = generation
          await update($, player, p => ({ ...p, isSpeaking: true }))
          // `say` speaks in the Mac's own system voice (Spoken Content, Siri voices
          // included) and, given a terminal, marks each word in bold as it says it.
          let argv = ['/usr/bin/script', '-q', '/dev/null', '/usr/bin/say', '--interactive=bold']
          if (prefs.voice) argv.push('-v', prefs.voice)
          if (prefs.wpm) argv.push('-r', String(prefs.wpm))
          argv.push('--', line.text)
          if (backend === 'command') {
            if (!bin) {
              const r = await $.process.run(build($.plugin.root), { timeoutMs: 300_000 })
              if (r.exitCode !== 0) throw new Error(`could not build the WAV player: ${r.stderr.slice(0, 300)}`)
              bin = r.stdout.trim()
            }
            const wav = bin.replace(/[^/]+$/, 'utterance.wav')
            const made = await $.process.run(['/bin/sh', '-c', command], {
              env: { OUT: wav },
              stdin: line.text,
              timeoutMs: 120_000,
            })
            if (made.exitCode !== 0) throw new Error(`TTS command failed: ${made.stderr.slice(0, 300)}`)
            argv = [bin, 'wav', wav]
          }
          if (gen === generation) {
            const child = $.process
              .spawn({ argv, input: backend === 'command' ? line.text : undefined, env: { TERM: 'xterm' } })
              [Symbol.asyncIterator]()
            current = child
            let pending = ''
            let said = 0 // how far the caption has got in this sentence
            for (let r = await child.next(); !r.done; r = await child.next()) {
              if (gen !== generation) break
              if (r.value.stream !== 'stdout') continue
              pending += r.value.text
              const words: string[] = []
              if (backend === 'command') {
                // The WAV player: `W <offset> <length>` per word.
                const lines = pending.split('\n')
                pending = lines.pop() ?? ''
                for (const l of lines) {
                  const m = /^W (\d+) (\d+)/.exec(l)
                  if (m) words.push(line.text.substr(Number(m[1]), Number(m[2])))
                }
              } else {
                // `say`: one frame per word, the word between bold on and off.
                const frames = pending.split('\r')
                pending = frames.pop() ?? ''
                for (const f of frames) {
                  const m = /\x1b\[1m(.*?)\x1b\(B/.exec(f)
                  if (m?.[1]) words.push(m[1])
                }
              }
              const spoken = words.pop()
              if (spoken === undefined) continue
              // The caption in the bar follows every word, wherever the reply is.
              const inLine = findWord(line.text, spoken, said)
              if (inLine !== -1) {
                said = inLine + 1
                const caption = { text: line.text, at: inLine, length: coreOf(spoken).length }
                await update($, player, p => ({ ...p, caption }))
              }
              const markdown = blocks.get(line.block) ?? ''
              const at = findWord(markdown, spoken, cursors.get(line.block) ?? 0)
              const id = messageOf(markdown)
              if (at === -1 || id === undefined) continue
              cursors.set(line.block, at + 1)
              if (lit !== undefined && lit !== id) await update($, memberOf(word, { requestId: lit }), () => null)
              lit = id
              const lead = markdown.length - markdown.trimStart().length
              await update($, memberOf(word, { requestId: id }), () => ({ at: at - lead, word: spoken }))
            }
            current = undefined
          }
          // Keep the last word lit between sentences; clear once the reply is all said.
          const isDone = gen !== generation || (queue.length === 0 && streaming === 0)
          if (isDone && lit !== undefined) {
            await update($, memberOf(word, { requestId: lit }), () => null)
            lit = undefined
          }
          if (queue.length === 0) await update($, player, p => ({ ...p, isSpeaking: false, caption: null }))
        } catch (err) {
          $.ui.toast(`read-aloud: ${err instanceof Error ? err.message : String(err)}`)
          queue = []
          await update($, player, p => ({ ...p, isSpeaking: false, caption: null }))
        }
      }
    })()

    return next(e)
  })

  on('command.run', { command: 'read-aloud' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'stop') stop()
    if (arg === 'on' || arg === 'off') await update($, isOn, () => arg === 'on')
    if (arg === 'again') replay()
    if (arg === 'demo') say([{ text: DEMO, block: '' }])

    return { text: `read-aloud is ${(await read($, isOn)) ? 'on' : 'off'}.` }
  })

  // The settings card: `/read-aloud` with no arguments draws voice, speed and highlight pickers.
  on('ui.render', { component: 'CommandOutput', props: { command: 'read-aloud' } }, async ($, e, next) => {
    if (e.props.args.trim() !== '' || e.surface === 'mobile') return next(e)
    const { Box, Button, Select, Text } = $.ui.resolve(e)
    const p = await read($, prefsAtom)
    const enabled = await read($, isOn)
    const voiceOptions = [{ value: 'system', label: 'System voice (Spoken Content)' }, ...voices]
    if (p.voice && !voices.some(v => v.value === p.voice)) voiceOptions.push({ value: p.voice, label: p.voice })
    const save = async (patch: Partial<Prefs>, isHeard: boolean) => {
      prefs = { ...prefs, ...patch }
      await update($, prefsAtom, () => prefs)
      await $.store.set('prefs', prefs)
      if (isHeard) say([{ text: DEMO, block: '' }])
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Read aloud</Text>
        <Select
          key="voice"
          label="Voice"
          value={p.voice || 'system'}
          options={voiceOptions}
          onSelect={v => save({ voice: v === 'system' ? '' : v }, true)}
        />
        <Select key="speed" label="Speed" value={String(p.wpm)} options={SPEEDS} onSelect={v => save({ wpm: Number(v) }, true)} />
        <Select
          key="style"
          label="Highlight"
          value={p.style in MARKS ? p.style : 'color'}
          options={STYLES}
          onSelect={v => save({ style: v as Prefs['style'] }, false)}
        />
        <Box flexDirection="row" gap={1}>
          <Button key="demo" label="Try it" onPress={() => say([{ text: DEMO, block: '' }])} />
          <Button key="stop" label="Stop" onPress={() => stop()} />
          <Button
            key="toggle"
            label={enabled ? 'Turn off' : 'Turn on'}
            onPress={async () => {
              if (enabled) stop()
              await update($, isOn, () => !enabled)
            }}
          />
        </Box>
        <Text dimColor>System voice follows System Settings, Accessibility, Spoken Content (Siri voices too).</Text>
      </Box>
    )
  })

  // The bar above the prompt: a caption of the sentence being said (it keeps
  // going while the reply itself is held, say by a text selection), and under
  // it one row of controls: stop or read again, speed, voice, highlight.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, player)
    if (e.props.hasSurvey || !(now.isSpeaking || now.canReplay) || !(await read($, isOn))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await read($, prefsAtom)
    const save = async (patch: Partial<Prefs>) => {
      prefs = { ...prefs, ...patch }
      await update($, prefsAtom, () => prefs)
      await $.store.set('prefs', prefs)
    }
    const c = now.caption
    const caption = c ? (
      <Text wrap="truncate-end">
        <Text dimColor>{c.text.slice(0, c.at)}</Text>
        <Text color="claude" bold>
          {c.text.slice(c.at, c.at + c.length)}
        </Text>
        <Text dimColor>{c.text.slice(c.at + c.length)}</Text>
      </Text>
    ) : (
      <Text dimColor wrap="truncate-end">
        {now.isSpeaking ? 'Reading aloud…' : 'Read aloud'}
      </Text>
    )
    const toggle = now.isSpeaking ? (
      <Button key="stop" label="Stop" onPress={() => stop()} />
    ) : (
      <Button key="again" label="Read again" onPress={() => replay()} />
    )
    const speed = SPEEDS.find(s => s.value === String(p.wpm))?.label ?? `${p.wpm} wpm`
    const buttons = (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="slower" label="Slower" onPress={() => save({ wpm: stepSpeed(p.wpm, -1) })} />
        <Text dimColor>{speed}</Text>
        <Button key="faster" label="Faster" onPress={() => save({ wpm: stepSpeed(p.wpm, 1) })} />
      </Box>
    )
    const bar = (controls: RenderChildren) => (
      <Box flexDirection="column" rowGap={1}>
        {caption}
        <Box flexDirection="row" columnGap={2} alignItems="center">
          {toggle}
          {controls}
        </Box>
      </Box>
    )

    // The mobile surface draws no Select: speed buttons only there.
    if (e.surface === 'mobile') return bar(buttons)
    const { Select } = $.ui.resolve(e)
    const voiceOptions = [{ value: 'system', label: 'System voice' }, ...voices]
    if (p.voice && !voices.some(v => v.value === p.voice)) voiceOptions.push({ value: p.voice, label: p.voice })
    const pickers = [
      <Select
        key="voice"
        value={p.voice || 'system'}
        options={voiceOptions}
        onSelect={v => save({ voice: v === 'system' ? '' : v })}
      />,
      <Select
        key="style"
        value={p.style in MARKS ? p.style : 'color'}
        options={STYLES}
        onSelect={v => save({ style: v as Prefs['style'] })}
      />,
    ]
    // VS Code draws no Client: speed buttons there too.
    if (e.surface === 'vscode') return bar([buttons, ...pickers])
    const { Client } = $.ui.resolve(e)
    return bar([<Client key="speed" module="./slider.tsx" props={{ wpm: p.wpm }} width={24} height={1} />, ...pickers])
  })

  // The slider posts the speed it was let go at.
  on('ui.message', { element: 'speed' }, async ($, e) => {
    const wpm = Number((e.data as { wpm?: unknown } | null)?.wpm)
    if (!Number.isFinite(wpm)) return {}
    prefs = { ...prefs, wpm }
    await update($, prefsAtom, () => prefs)
    await $.store.set('prefs', prefs)

    return { props: { wpm } }
  })

  // A new prompt: the old reply is moot.
  on('prompt.submit', async ($, e, next) => {
    halt()
    isStopped = false
    reply = []
    blocks.clear()
    cursors.clear()
    await update($, player, () => ({ isSpeaking: false, canReplay: false, caption: null }))

    return next(e)
  })

  // Typing in the prompt box stops the reading.
  on('prompt.edit', ($, e, next) => {
    if (queue.length > 0 || current !== undefined) stop()

    return next(e)
  })

  // So does dictation, or anything else that fills the box (a submit's clear aside).
  on('prompt.change', ($, e, next) => {
    if (e.origin.kind !== 'clear' && e.text !== '') stop()

    return next(e)
  })

  // Tap the main loop's streamed text and queue each sentence as it finishes.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !(await read($, isOn))) return yield* next(e)
    let buffer = ''
    let inFence = false
    let block = ''
    streaming += 1
    try {
      for await (const piece of next(e)) {
        yield piece
        if (piece.kind !== 'text') continue
        const key = `${e.turnId}:${e.index}:${piece.index}`
        if (key !== block && block) {
          heard(chunk(buffer, inFence, true).sentences.map(text => ({ text, block })))
          buffer = ''
          inFence = false
        }
        block = key
        blocks.set(key, (blocks.get(key) ?? '') + piece.text)
        const r = chunk(buffer + piece.text, inFence)
        buffer = r.rest
        inFence = r.inFence
        heard(r.sentences.map(text => ({ text, block: key })))
        if (reply.length > 0 && !(await read($, player)).canReplay) {
          await update($, player, p => ({ ...p, canReplay: true }))
        }
      }
      heard(chunk(buffer, inFence, true).sentences.map(text => ({ text, block })))
    } finally {
      streaming -= 1
    }
  })

  // Mark the word being said in the reply itself.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // ponytail: remembers every drawn message by its head; a long session's
    // map grows with it. Bound it if that ever matters.
    const head = headOf(e.props.text)
    if (head.length >= 4) {
      messages.delete(head)
      messages.set(head, e.requestId)
    }
    const n = await read($, memberOf(word, e))
    if (n === null) return next(e)
    const lead = e.props.text.length - e.props.text.trimStart().length
    const [open, close] = MARKS[(await read($, prefsAtom)).style] ?? MARKS.color

    return next({ ...e, props: { ...e.props, text: highlight(e.props.text, n.word, n.at + lead, open, close) } })
  })
}
