import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../index.js'

/** A Host context stub that records what the plugin registers. */
function hostContext(services = {}) {
  const listeners = new Map()
  const registered = []
  const ctx = {
    registered,
    listeners,
    services,
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(callback) {
      return callback()
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    },
    get(service) {
      return services[service]
    },
    logger: { warn() {} },
  }
  return ctx
}

/** One Agent whose session reports the given messages. */
function fakeAgent(messages = []) {
  return { id: 'session-parent', session: { deriveMessages: () => messages } }
}

/** The subagent service stub: hands the child id back so the test can fire `agent/created`. */
function fakeSubagents({ reply, stopReason = 'completed', diagnostic } = {}) {
  return {
    specs: [],
    startActivation(spec) {
      this.specs.push(spec)
      return Promise.resolve({
        childId: spec.childId,
        result: Promise.resolve({
          output: [{ type: 'text', text: reply }],
          stopReason,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        }),
        dispose: () => Promise.resolve(),
      })
    },
  }
}

test('the bundle exports a Loader-visible plugin', () => {
  assert.equal(name, 'dsh-better')
  assert.deepEqual(inject, ['commands'])
})

test('apply registers /better with an input hint', () => {
  const ctx = hostContext()
  apply(ctx, {})
  assert.equal(ctx.registered.length, 1)
  const command = ctx.registered[0]
  assert.equal(command.name, 'better')
  assert.equal(typeof command.handler, 'function')
  assert.match(command.input.hint, /what you want done/)
  assert.match(command.description, /top professional/)
})

test('/better with nothing to deepen explains the fix', async () => {
  const ctx = hostContext()
  apply(ctx, {})
  const result = await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: '   ',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Nothing to deepen/)
})

test('/better without a subagent service names the missing piece', async () => {
  const ctx = hostContext()
  apply(ctx, {})
  const result = await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'make the errors clearer',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /subagent service is not loaded/)
})

test('/better returns the marked rewrite and restricts the helper tools', async () => {
  const subagents = fakeSubagents({
    reply: 'Answers.\n<improved-prompt>Make the retries idempotent.</improved-prompt>',
  })
  const ctx = hostContext({ subagents })
  apply(ctx, {})

  const pending = ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'make the retries idempotent',
    signal: new AbortController().signal,
  })

  const spec = await waitFor(() => subagents.specs[0])
  const restrictions = []
  const child = { id: spec.childId, ctx: { tools: { restrict: (value) => restrictions.push(value) } } }
  for (const listener of ctx.listeners.get('agent/created') ?? []) listener({ agent: child })

  const result = await pending
  assert.deepEqual(result, { kind: 'success', text: 'Make the retries idempotent.' })
  assert.equal(restrictions.length, 1)
  assert.ok(restrictions[0].allow.includes('read'))
  assert.ok(restrictions[0].allow.includes('grep'))
  assert.ok(!restrictions[0].allow.includes('write'))
  assert.ok(!restrictions[0].allow.includes('edit'))
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.parent.id, 'session-parent')
  assert.equal(spec.request.prompt[0].type, 'text')
  assert.ok(spec.request.prompt[0].text.includes('make the retries idempotent'))
})

test('/better forwards a configured model route', async () => {
  const subagents = fakeSubagents({ reply: '<improved-prompt>do it</improved-prompt>' })
  const ctx = hostContext({ subagents })
  apply(ctx, { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high', subagentProvider: 'fork' })
  await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'do the thing',
    signal: new AbortController().signal,
  })
  const spec = subagents.specs[0]
  assert.deepEqual(spec.request.agentOptions, {
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'high',
  })
  assert.equal(spec.provider, 'fork')
})

test('/better ignores half a model route', async () => {
  const subagents = fakeSubagents({ reply: '<improved-prompt>do it</improved-prompt>' })
  const ctx = hostContext({ subagents })
  apply(ctx, { provider: 'openai' })
  await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'do the thing',
    signal: new AbortController().signal,
  })
  assert.equal(subagents.specs[0].request.agentOptions, undefined)
})

test('/better reports a reply that carries no marked prompt', async () => {
  const subagents = fakeSubagents({ reply: 'I could not decide what you meant.' })
  const ctx = hostContext({ subagents })
  apply(ctx, {})
  const result = await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'improve this',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /without the <improved-prompt> block/)
  assert.match(result.text, /I could not decide/)
})

test('/better reports an aborted run without pretending it worked', async () => {
  const subagents = fakeSubagents({ reply: '', stopReason: 'aborted' })
  const ctx = hostContext({ subagents })
  apply(ctx, {})
  const result = await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'improve this',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Stopped/)
})

test('/better reports a run that produced no text', async () => {
  const subagents = fakeSubagents({ reply: '', stopReason: 'error', diagnostic: 'provider exploded' })
  const ctx = hostContext({ subagents })
  apply(ctx, {})
  const result = await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'improve this',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /stopped on an error/)
  assert.match(result.text, /provider exploded/)
})

test('bare /better deepens the session tail', async () => {
  const subagents = fakeSubagents({ reply: '<improved-prompt>speed up the build</improved-prompt>' })
  const ctx = hostContext({ subagents })
  apply(ctx, {})
  const result = await ctx.registered[0].handler({
    agent: fakeAgent([{ role: 'user', content: [{ type: 'text', text: 'the build is slow' }] }]),
    rawInput: '',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.ok(subagents.specs[0].request.prompt[0].text.includes('the build is slow'))
})

test('a start failure names the provider and the config key', async () => {
  const ctx = hostContext({
    subagents: {
      startActivation() {
        return Promise.reject(new Error('no such provider'))
      },
    },
  })
  apply(ctx, { subagentProvider: 'nope' })
  const result = await ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'improve this',
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /could not start/)
  assert.match(result.text, /"nope"/)
})

test('the helper run is aborted when the invocation is cancelled', async () => {
  let captured
  const ctx = hostContext({
    subagents: {
      startActivation(spec) {
        captured = spec
        return Promise.resolve({
          childId: spec.childId,
          result: new Promise((resolve) => {
            spec.signal.addEventListener('abort', () =>
              resolve({ output: [], stopReason: 'aborted' }),
            )
          }),
          dispose: () => Promise.resolve(),
        })
      },
    },
  })
  apply(ctx, {})
  const controller = new AbortController()
  const pending = ctx.registered[0].handler({
    agent: fakeAgent([]),
    rawInput: 'improve this',
    signal: controller.signal,
  })
  await waitFor(() => captured)
  controller.abort()
  const result = await pending
  assert.equal(captured.signal.aborted, true)
  assert.match(result.text, /cancelled/)
})

/**
 * @param {() => unknown} read - poll target.
 * @returns {Promise<unknown>} the first truthy value.
 */
async function waitFor(read) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for the value')
}
