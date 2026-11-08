// The word being said now in one reply block (a family member per message,
// so only that message redraws): `at` is its offset in the block's markdown,
// leading whitespace not counted.
export type Now = { at: number; word: string } | null

// The voice ('' = the Mac's system voice), speed in words per minute
// (0 = the system's) and how the spoken word is marked.
export type Prefs = { voice: string; wpm: number; style: 'color' | 'colorbold' | 'box' | 'bold' | 'italic' | 'bolditalic' }

// What the control bar above the prompt shows: the sentence being said, with
// where its current word starts and how long it is, as a caption.
export type Caption = { text: string; at: number; length: number }
export type Player = { isSpeaking: boolean; canReplay: boolean; caption?: Caption | null }

declare module 'claude-code' {
  interface PluginState {
    'read-aloud': { word: StateFamily<Now>; isOn: boolean; prefs: Prefs; player: Player }
  }
}
