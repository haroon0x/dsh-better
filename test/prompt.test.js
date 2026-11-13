import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEPTH_PROMPT,
  MAX_PROMPT_CHARS,
  buildBetterTask,
  parseImprovedPrompt,
  textOf,
  transcriptFromMessages,
} from '../lib/prompt.js'

test('parseImprovedPrompt returns the marked block', () => {
  const reply = 'Here are the four answers.\n\n<improved-prompt>\nMake the retries idempotent.\n</improved-prompt>\n'
  assert.deepEqual(parseImprovedPrompt(reply), {
    found: true,
    prompt: 'Make the retries idempotent.',
    reason: 'ok',
  })
})

test('parseImprovedPrompt accepts an uppercase tag and a missing closing tag', () => {
  assert.equal(parseImprovedPrompt('<IMPROVED-PROMPT>Do it</IMPROVED-PROMPT>').prompt, 'Do it')
  assert.deepEqual(parseImprovedPrompt('<improved-prompt>Do it'), {
    found: true,
    prompt: 'Do it',
    reason: 'ok',
  })
})

test('parseImprovedPrompt drops one wrapping code fence', () => {
  const reply = '<improved-prompt>\n```markdown\nRewrite the parser.\n```\n</improved-prompt>'
  assert.equal(parseImprovedPrompt(reply).prompt, 'Rewrite the parser.')
})

test('parseImprovedPrompt reports a missing or empty block', () => {
  assert.deepEqual(parseImprovedPrompt('No block here.'), { found: false, prompt: '', reason: 'missing' })
  assert.deepEqual(parseImprovedPrompt('<improved-prompt>   \n</improved-prompt>'), {
    found: false,
    prompt: '',
    reason: 'empty',
  })
  assert.deepEqual(parseImprovedPrompt(undefined), { found: false, prompt: '', reason: 'missing' })
})

test('parseImprovedPrompt caps a runaway rewrite', () => {
  const huge = 'x'.repeat(MAX_PROMPT_CHARS + 500)
  const parsed = parseImprovedPrompt(`<improved-prompt>${huge}</improved-prompt>`)
  assert.equal(parsed.found, true)
  assert.ok(parsed.prompt.length < huge.length)
  assert.ok(parsed.prompt.endsWith('… (truncated)'))
})

test('textOf keeps text blocks and drops everything else', () => {
  assert.equal(
    textOf([
      { type: 'text', text: 'a' },
      { type: 'tool-call', name: 'read' },
      { type: 'text', text: 'b' },
    ]),
    'ab',
  )
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf(null), '')
})

test('transcriptFromMessages keeps user and assistant text only', () => {
  const transcript = transcriptFromMessages([
    { role: 'system', content: [{ type: 'text', text: 'ignore me' }] },
    { role: 'user', content: [{ type: 'text', text: 'first ask' }] },
    { role: 'tool', content: [{ type: 'text', text: 'ignore me too' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
  ])
  assert.equal(transcript, 'USER:\nfirst ask\n\nASSISTANT:\nan answer')
})

test('transcriptFromMessages keeps the newest messages when over budget', () => {
  const messages = Array.from({ length: 40 }, (_value, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `message ${index}` }],
  }))
  const transcript = transcriptFromMessages(messages, { maxMessages: 3 })
  assert.ok(transcript.includes('message 39'))
  assert.ok(!transcript.includes('message 30'))
  assert.equal(transcript.split('USER:').length - 1, 3)
})

test('transcriptFromMessages clips one oversized message', () => {
  const transcript = transcriptFromMessages(
    [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(50) }] }],
    { perMessageChars: 10 },
  )
  assert.equal(transcript, 'USER:\nyyyyyyyyyy\n… (truncated)')
})

test('transcriptFromMessages is empty when nothing is deepenable', () => {
  assert.equal(transcriptFromMessages([]), '')
  assert.equal(transcriptFromMessages([{ role: 'system', content: [] }]), '')
})

test('buildBetterTask carries the request, the four questions and the output contract', () => {
  const task = buildBetterTask({ request: '  make the errors clearer  ' })
  assert.ok(task.includes('make the errors clearer'))
  assert.ok(task.includes(DEPTH_PROMPT))
  assert.ok(task.includes('<improved-prompt>'))
  assert.ok(task.includes('Never carry the request out.'))
  assert.ok(!task.includes('<session>'))
})

test('buildBetterTask deepens the session when no request is typed', () => {
  const task = buildBetterTask({ transcript: 'USER:\nspeed up the build\n\nASSISTANT:\nWhich part?' })
  assert.ok(task.includes('<session>'))
  assert.ok(task.includes('speed up the build'))
  assert.ok(task.includes('take it from my session below'))
})
