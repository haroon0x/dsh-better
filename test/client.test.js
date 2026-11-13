import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The bundle runs `window.__ModuleLoader__.load(...)` at import time, so the
 * loader is stubbed before the module is imported and the factory is pulled
 * back out of the stub.
 */
const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry)
    },
  },
}

const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
}

await import('../client.js')

const entry = loaded[0]

/**
 * A Client context stub: records listeners and slot registrations.
 *
 * @param {object} options - services and composer behaviour.
 * @param {object} [options.inputState] - what `state.getSnapshot()` returns.
 * @returns {object} the fake context.
 */
function clientContext({ inputState = { phase: 'plain', draft: '' }, hasScope = true } = {}) {
  const calls = []
  const listeners = new Map()
  const registrations = []
  const input = {
    state: { getSnapshot: () => inputState },
    setDraft(text) {
      calls.push({ kind: 'setDraft', text })
    },
    notify(level, text) {
      calls.push({ kind: 'notify', level, text })
    },
    focus() {
      calls.push({ kind: 'focus' })
    },
  }
  const conversation = { input: { for: () => input } }
  const scope = hasScope ? { get: (name) => (name === 'conversation' ? conversation : undefined) } : undefined
  const ctx = {
    calls,
    listeners,
    registrations,
    services: {
      sessions: { scope: () => scope },
      conversation,
      locale: {
        register() {},
        bind() {
          return (key) => `localized:${key}`
        },
      },
    },
    get(name) {
      return ctx.services[name]
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener))
      }
    },
    effect(callback) {
      return callback()
    },
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'conversation.input.dock')
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return ctx
}

test('the client bundle registers under its package id', () => {
  assert.equal(entry.id, '@haroon0x/dsh-better')
  assert.equal(typeof entry.factory, 'function')
})

test('apply registers the composer listener and the status row', () => {
  const ctx = clientContext()
  const plugin = entry.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected module: ${name}`)
  })
  assert.deepEqual(plugin.inject, ['slots'])
  plugin.apply(ctx)
  assert.equal((ctx.listeners.get('command/executed') ?? []).length, 1)
  assert.equal(ctx.registrations.length, 1)
  assert.equal(ctx.registrations[0].options.id, 'dsh-better-status')
  assert.equal(ctx.registrations[0].options.name, 'conversation.input.dock')
})

test('a finished /better run lands in the composer', async () => {
  const ctx = clientContext()
  const plugin = entry.factory(() => react)
  plugin.apply(ctx)
  const [listener] = ctx.listeners.get('command/executed')
  listener('session-1', 'better', { kind: 'success', text: 'Make the retries idempotent.' })

  await waitFor(() => ctx.calls.find((call) => call.kind === 'setDraft'))
  const write = ctx.calls.find((call) => call.kind === 'setDraft')
  assert.equal(write.text, 'Make the retries idempotent.')
  const notice = ctx.calls.find((call) => call.kind === 'notify')
  assert.equal(notice.level, 'info')
  assert.match(notice.text, /localized:notice\.inBox/)
})

test('a draft typed while waiting stays below the rewrite', async () => {
  const ctx = clientContext({ inputState: { phase: 'plain', draft: '  my own note  ' } })
  const plugin = entry.factory(() => react)
  plugin.apply(ctx)
  const [listener] = ctx.listeners.get('command/executed')
  listener('session-1', 'better', { kind: 'success', text: 'Rewrite.' })

  await waitFor(() => ctx.calls.find((call) => call.kind === 'setDraft'))
  assert.equal(ctx.calls.find((call) => call.kind === 'setDraft').text, 'Rewrite.\n\nmy own note')
  const notice = ctx.calls.find((call) => call.kind === 'notify')
  assert.match(notice.text, /localized:notice\.keptDraft/)
})

test('the write waits while the composer is still submitting', async () => {
  const state = { phase: 'submitting', draft: '/better x' }
  const ctx = clientContext({ inputState: state })
  const plugin = entry.factory(() => react)
  plugin.apply(ctx)
  const [listener] = ctx.listeners.get('command/executed')
  listener('session-1', 'better', { kind: 'success', text: 'Rewrite.' })

  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(ctx.calls.filter((call) => call.kind === 'setDraft').length, 0)

  state.phase = 'plain'
  state.draft = ''
  await waitFor(() => ctx.calls.find((call) => call.kind === 'setDraft'))
  assert.equal(ctx.calls.find((call) => call.kind === 'setDraft').text, 'Rewrite.')
})

test('other commands, failures and empty results are ignored', async () => {
  const ctx = clientContext()
  const plugin = entry.factory(() => react)
  plugin.apply(ctx)
  const [listener] = ctx.listeners.get('command/executed')
  listener('session-1', 'plan', { kind: 'success', text: 'Plan mode on.' })
  listener('session-1', 'better', { kind: 'error', text: 'No.' })
  listener('session-1', 'better', { kind: 'success' })
  listener('session-1', 'better', { kind: 'success', text: '   ' })

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(ctx.calls.filter((call) => call.kind === 'setDraft').length, 0)
})

test('a session without a client scope is left alone', async () => {
  const ctx = clientContext({ hasScope: false })
  const plugin = entry.factory(() => react)
  plugin.apply(ctx)
  const [listener] = ctx.listeners.get('command/executed')
  listener('session-gone', 'better', { kind: 'success', text: 'Rewrite.' })

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(ctx.calls.filter((call) => call.kind === 'setDraft').length, 0)
})

test('the status row renders only while a /better run is submitting', () => {
  const ctx = clientContext()
  const plugin = entry.factory(() => react)
  plugin.apply(ctx)
  const row = ctx.registrations[0].component

  const idle = row({ useInput: () => false })
  assert.equal(idle, null)

  const running = row({ useInput: () => true })
  assert.equal(running.type, 'div')
  assert.equal(running.props.role, 'status')
})

test('the status selector matches only this command', () => {
  const ctx = clientContext()
  const plugin = entry.factory(() => react)
  plugin.apply(ctx)
  const row = ctx.registrations[0].component

  let selector
  row({ useInput: (fn) => (selector = fn) })
  assert.equal(selector({ phase: 'submitting', claim: { name: 'better' } }), true)
  assert.equal(selector({ phase: 'submitting', claim: { name: 'plan' } }), false)
  assert.equal(selector({ phase: 'plain' }), false)
  assert.equal(selector(undefined), false)
})

/**
 * @param {() => unknown} read - poll target.
 * @returns {Promise<void>} resolves once the value is truthy.
 */
async function waitFor(read) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (read() !== undefined) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for the value')
}
