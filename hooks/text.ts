// Turns streamed markdown into speakable sentences.

export type Chunked = { sentences: string[]; rest: string; inFence: boolean }

// Pictographs, flags, skin tones, joiners, variation selectors and keycap marks.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu

// Plain words from one line of markdown; '' for lines not worth saying.
export function speakable(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images: their text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, '') // headings, quotes, bullets
    .replace(/\*+|~~/g, '') // emphasis
    .replace(/\|/g, ' ') // table cells
    .replace(/^\s*-{3,}\s*$/, '')
    .replace(EMOJI, '') // `say` would read each one out by name
    .replace(/\s+/g, ' ')
    .replace(/ ([.!?,;:])/g, '$1') // a dropped emoji leaves a gap before punctuation
    .trim()
}

// Splits off every finished sentence of `buffer`; `rest` waits for more text.
// `isFinal` flushes the rest too. Code fences are skipped whole.
export function chunk(buffer: string, inFence: boolean, isFinal = false): Chunked {
  const sentences: string[] = []
  const lines = buffer.split('\n')
  let rest = isFinal ? '' : lines.pop() ?? ''
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) sentences.push(...split(line))
  }
  // The unfinished line: say its finished sentences now, keep the tail.
  if (!inFence && rest && !/^\s*(```|~~~)/.test(rest)) {
    const done = rest.match(/^.*[.!?](?=\s)/)
    if (done && !/^\s*\d+[.)]$/.test(done[0])) {
      sentences.push(...split(done[0]))
      rest = rest.slice(done[0].length)
    }
  }
  return { sentences: sentences.filter(Boolean), rest, inFence }
}

function split(line: string): string[] {
  const text = speakable(line)
  if (!text) return []
  // ponytail: naive sentence split, so "e.g. this" breaks early; fine for speech.
  const parts = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [text]
  return parts.map(p => p.trim())
}

// Where a spoken word sits in the markdown, at or after `from`; -1 if not
// within reach. The spoken form drops punctuation and markup, so match the
// word's letters alone.
export const coreOf = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

// Parts of a block's markdown that are never spoken: code fences, link and
// image targets, bare URLs. A word is never looked for in them.
function unspoken(markdown: string): [number, number][] {
  const out: [number, number][] = []
  let fence: number | undefined
  let pos = 0
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence === undefined) fence = pos
      else {
        out.push([fence, pos + line.length])
        fence = undefined
      }
    }
    pos += line.length + 1
  }
  if (fence !== undefined) out.push([fence, markdown.length])
  for (const m of markdown.matchAll(/\]\([^)]*\)|https?:\/\/\S+/g)) out.push([m.index, m.index + m[0].length])
  return out
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

// The first whole word `word` at or after `from`, outside what is never
// spoken ("a" is not the "a" in "data"); -1 if none within reach.
export function findWord(markdown: string, word: string, from: number): number {
  const core = coreOf(word)
  if (!core) return -1
  const dead = unspoken(markdown)
  for (let at = markdown.indexOf(core, from); at !== -1 && at - from < 400; at = markdown.indexOf(core, at + 1)) {
    if (isWordChar(markdown[at - 1]) || isWordChar(markdown[at + core.length])) continue
    if (dead.some(([start, end]) => at >= start && at < end)) continue
    return at
  }
  return -1
}

// The inline code span around `pos`: where it starts and ends (delimiters included) and its delimiter.
function codeAround(markdown: string, pos: number): { from: number; to: number; tick: string } | null {
  let open: { at: number; len: number } | undefined
  for (const m of markdown.matchAll(/`+/g)) {
    const len = m[0].length
    if (len >= 3) open = undefined // a fence
    else if (!open) open = { at: m.index, len }
    else if (open.len === len) {
      if (pos > open.at && pos < m.index) return { from: open.at, to: m.index + len, tick: m[0] }
      open = undefined
    }
  }
  return null
}

// The markdown with the word at (or just after) `near` wrapped in `open` and
// `close`: `**` bold, `***` bold italic, a backtick a code box, a link colour.
// Where the word already sits in code, a link or the same emphasis, the marks
// give way to ones that nest, so the surrounding formatting survives.
export function highlight(markdown: string, word: string, near: number, open = '**', close = open): string {
  const span = wordSpan(markdown, word, near)
  if (!span) return markdown
  const [a, b] = span
  const line = markdown.slice(markdown.lastIndexOf('\n', a) + 1, a).replace(/`[^`]*`/g, '')
  const lone = line.replace(/\*\*/g, '')
  const inBold = (line.match(/\*\*/g)?.length ?? 0) % 2 === 1
  const inItalic = (lone.match(/\*/g)?.length ?? 0) % 2 === 1
  const opened = line.lastIndexOf('[')
  const inLink = opened !== -1 && !line.slice(opened).includes(']') && markdown.indexOf('](', b) !== -1
  const code = codeAround(markdown, a)
  if (code && open === '`') return markdown // already boxed
  if (inLink && open.includes('[')) {
    open = open.replace('[', '') || '**' // a link inside a link will not do
    close = close.replace(/\]\([^)]*\)/, '') || '**'
  }
  if (inBold && open.startsWith('**')) {
    open = open.slice(2) || '*'
    close = close.slice(0, -2) || '*'
  }
  if (inItalic && open === '*') [open, close] = ['**', '**']
  if (!code) return `${markdown.slice(0, a)}${open}${markdown.slice(a, b)}${close}${markdown.slice(b)}`
  // In code: split the span around the word, which keeps its own backticks inside the marks.
  const { from, to, tick } = code
  const before = markdown.slice(from + tick.length, a)
  const after = markdown.slice(b, to - tick.length)
  const marked = `${before ? tick + before + tick : ''}${open}${tick}${markdown.slice(a, b)}${tick}${close}${after ? tick + after + tick : ''}`
  return markdown.slice(0, from) + marked + markdown.slice(to)
}

// [start, end) of the word at (or just after) `near`; null if not within reach.
export function wordSpan(markdown: string, word: string, near: number): [number, number] | null {
  const at = findWord(markdown, word, Math.max(0, near - 2))
  return at === -1 ? null : [at, at + coreOf(word).length]
}

// The novelty voices macOS ships (Bells, Zarvox...): not worth listing.
const NOVELTY = new Set(
  'Albert,Bad News,Bahh,Bells,Boing,Bubbles,Cellos,Wobble,Good News,Jester,Organ,Superstar,Trinoids,Whisper,Zarvox,Junior,Ralph,Fred,Kathy'.split(','),
)

// English voices from `say -v '?'` output, novelty voices left out.
export function parseVoices(listing: string): { value: string; label: string }[] {
  const seen = new Set<string>()
  return listing.split('\n').flatMap(l => {
    const m = /^(.+?)\s{2,}(en_[A-Z]{2})\s/.exec(l)
    const name = m?.[1]
    if (!m || !name || NOVELTY.has(name) || seen.has(name)) return []
    seen.add(name)
    return [{ value: name, label: `${name} (${m[2]})` }]
  })
}
