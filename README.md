# read-aloud

A Claude Code mod that reads Claude's replies aloud **while they stream**, in
your Mac's own voice, and highlights each word **in the chat** as it is
spoken, karaoke style. Runs fully on your Mac. No API keys, no cloud.

## Install

macOS only (it speaks with the built-in `say`).

At the prompt of a Claude Code terminal session:

```
/plugin install read-aloud --marketplace DanAndresSanchez/claude-voice-mod
```

Answer `y` to add the marketplace, then pick a scope. From a shell instead:

```bash
claude plugin install read-aloud --marketplace DanAndresSanchez/claude-voice-mod
```

In the desktop app: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `DanAndresSanchez/claude-voice-mod`, then **Add plugin**.

From a local clone, for hacking on it:

```bash
claude --plugin-dir ./claude-voice-mod
```

## Use

Every reply is read as it arrives, a sentence at a time, and the word being
said is marked in the reply: recoloured by default (no letter changes width,
so the line never shifts), or colour and bold, a box, bold, italic or bold
italic. Pick it under Highlight in the bar or the `/read-aloud` card.

A bar above the prompt box shows while a reply is read, and stays after it.
Its top line is a caption of the sentence being said, the word marked; it keeps
going even when the reply itself stops redrawing (the desktop app holds a
message while you select text in it). Under it, one row of controls:
**Stop** (or **Read again**), a speed slider (drag it, or click it and use the
arrow keys), a voice picker and the highlight style. VS Code and mobile get Slower / Faster
buttons instead of the slider.
Typing in the prompt box, dictating into it or sending a new prompt stops the
reading too.

| Command | Does |
| --- | --- |
| `/read-aloud` | settings card: voice, speed, highlight style, try it, stop, turn off/on |
| `/read-aloud again` | read the latest reply again |
| `/read-aloud demo` | speak a test sentence |
| `/read-aloud stop` | stop the current reply |
| `/read-aloud off` / `on` | mute / unmute |
| `/read-aloud where` | is this session the one that speaks |

Code blocks, URLs, markdown symbols and emoji are skipped. Subagents are not read.

With several sessions open, only one talks. In the desktop app that is the
session you are looking at (the focused pane); elsewhere, such as a terminal,
the one you touched last (typed in, sent a prompt, pressed a control). The
others stay quiet. `/read-aloud where` says which rule applies and whether the
session speaks.

## Picking a voice

By default it uses **your Mac's system voice**, the one Speak Selection uses:
System Settings → Accessibility → Spoken Content → System voice. That
includes the natural Siri voices, which sound far better than the old named
voices. Change it there and read-aloud follows.

To pick a different voice or speed for Claude alone, run `/read-aloud` and
use the card (each pick plays a sample; the choice is saved across sessions).
Siri voices can't be named there, only used as the system voice. Download more
under Spoken Content → System voice → Manage Voices; the *Premium* and
*Enhanced* ones are the good ones.

## Settings

In `/config` in a terminal session, or `pluginConfigs` in
`~/.claude/settings.json`:

| Setting | Default | |
| --- | --- | --- |
| `backend` | `system` | `system` = your Mac's voice; `command` = your own TTS |
| `command` | | for `command`: a shell command that reads text on stdin and writes a WAV to `$OUT` |

### Open-model voices

Set `backend` to `command` and `command` to one of:

- **Piper** (`pip install piper-tts`, download a voice `.onnx`):
  `piper --model ~/voices/en_US-lessac-medium.onnx --output_file "$OUT"`
- **Kokoro** (`pip install kokoro-onnx soundfile`, plus its model files): a
  short script that reads stdin and writes `$OUT`.
- Anything else that writes a WAV.

That engine needs the Xcode command line tools (`xcode-select --install`): a
small Swift player in `helper/` is compiled once, on first use. A plain WAV has
no word timings, so the highlight is spread over the clip by word length:
close, not exact. Whisper is speech-to-text, the other direction, so it is not
a voice option.

## How it works

- `hooks/register.tsx` hooks `turn.step`, the model's response as it streams,
  passes every piece through untouched, and cuts the text into sentences
  (`hooks/text.ts`).
- A speaker loop runs each sentence through `say --interactive`, under
  `script` so `say` thinks it has a terminal; `say` then marks each word as it
  speaks it, and the mod reads those marks.
- A `ui.render` hook on the reply bolds the current word in the chat. Only the
  drawing changes; the stored reply is untouched.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT, see `LICENSE`.
