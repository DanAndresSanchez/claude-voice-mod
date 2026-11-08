import { expect, test } from 'claude-code/testing'

import { chunk, highlight, parseVoices } from './text'

test('streamed markdown becomes sentences, code skipped', async () => {
  let r = chunk('Hello **Dan**. This is', false)
  expect(r.sentences).toEqual(['Hello Dan.'])
  expect(r.rest).toBe(' This is')

  r = chunk(r.rest + ' a test.\n```ts\nconst x = 1.\n', r.inFence)
  expect(r.sentences).toEqual(['This is a test.'])
  expect(r.inFence).toBe(true)

  r = chunk(r.rest + '```\n- See [the docs](https://x.dev) and `npm i`.\n1. ', r.inFence)
  expect(r.sentences).toEqual(['See the docs and npm i.'])
  expect(r.inFence).toBe(false)

  expect(chunk(r.rest + 'Last step', r.inFence, true).sentences).toEqual(['Last step'])
})

test('the spoken word is bolded in place, the right occurrence', async () => {
  const md = 'The cat and the dog, Dan.'
  expect(highlight(md, 'the', 12)).toBe('The cat and **the** dog, Dan.')
  expect(highlight(md, 'Dan.', 21)).toBe('The cat and the dog, **Dan**.')
  expect(highlight(md, 'zebra', 0)).toBe(md)
  expect(highlight(md, 'dog,', 16, '`')).toBe('The cat and the `dog`, Dan.')
  expect(highlight(md, 'cat', 0, '[', '](x)')).toBe('The [cat](x) and the dog, Dan.')
})

test('the bar above the prompt offers Read again once a reply was heard', async ($, on) => {
  on('state.get', { key: 'player' }, () => ({ value: { value: { isSpeaking: false, canReplay: true }, version: 1 } }))
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await ui.find({ type: 'Button', key: 'again' }))?.props.label).toBe('Read again')
    // A slider where the surface draws one, speed buttons elsewhere.
    const speed = surface === 'mobile' ? { type: 'Button', key: 'faster' } : { type: 'Client', key: 'speed' }
    expect(await ui.find(speed)).toBeDefined()
    await ui.unmount()
  }
})

test('a reply is drawn as the engine draws it while nothing is being said', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'AssistantMessage' ? e.props.text : ''}</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      component: 'AssistantMessage',
      requestId: 'm1',
      surface,
      props: { text: 'Hello there.', isFirstOfReply: true },
    })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('Hello there.')
    await ui.unmount()
  }
})

test('the voice list keeps real English voices only', async () => {
  const listing = 'Albert              en_US    # Hello!\nAva (Premium)       en_US    # Hello!\nAmélie              fr_CA    # Bonjour\n'
  expect(parseVoices(listing)).toEqual([{ value: 'Ava (Premium)', label: 'Ava (Premium) (en_US)' }])
})

test('/read-aloud draws the voice and speed card', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      component: 'CommandOutput',
      requestId: 'c1',
      surface,
      props: { command: 'read-aloud', args: '', text: 'read-aloud is on.', isErrored: false },
    })
    expect((await ui.find({ type: 'Select', key: 'voice' }))?.props.value).toBe('system')
    expect((await ui.find({ type: 'Select', key: 'speed' }))?.props.value).toBe('0')
    await ui.unmount()
  }
})

test('dragging the speed slider to its left end sets the slowest speed', async ($, on) => {
  on('state.get', { key: 'player' }, () => ({ value: { value: { isSpeaking: true, canReplay: true }, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    await ui.resize({ columns: 24, rows: 1, in: 'speed' })
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'speed' })
    await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'speed' })
    const slider = await ui.find({ type: 'Client', key: 'speed' })
    expect((slider?.props.props as { wpm: number }).wpm).toBe(120)
    await ui.key({ key: 'right', in: 'speed' })
    expect(((await ui.find({ type: 'Client', key: 'speed' }))?.props.props as { wpm: number }).wpm).toBe(130)
    await ui.unmount()
  }
})

test('the bar captions the sentence being said, its word marked', async ($, on) => {
  const caption = { text: 'Hello there, Dan.', at: 6, length: 5 }
  on('state.get', { key: 'player' }, () => ({ value: { value: { isSpeaking: true, canReplay: true, caption }, version: 1 } }))
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /^there$/ }))?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
    await ui.unmount()
  }
})

test('the terminal puts a background on the spoken word, desktop keeps markdown', async ($, on) => {
  on('state.get', { key: 'word' }, () => ({ value: { value: { at: 6, word: 'there.' }, version: 1 } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'AssistantMessage' ? e.props.text : ''}</Text>
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'read-aloud',
      component: 'AssistantMessage',
      requestId: 'm1',
      surface,
      props: { text: 'Hello there.', isFirstOfReply: true },
    })
    const lit = await ui.find({ type: 'Text', text: /^there$/ })
    if (surface === 'terminal') expect(lit?.props.backgroundColor).toBe('claude')
    else expect(lit).toBeUndefined()
    await ui.unmount()
  }
})
