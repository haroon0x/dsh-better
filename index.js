/**
 * dsh-better — Host half.
 *
 * Registers `/better`: a human slash command that deepens one request before
 * it is sent. It reads the workspace with a read-only helper Agent, applies
 * Felix Rieseberg's four "Depth" questions, and returns the rewritten request
 * as the command result. The Client half of this bundle delivers that text to
 * the composer's input box; this half never touches the composer itself.
 *
 * @module @haroon0x/dsh-better
 */
import {
  buildBetterTask,
  parseImprovedPrompt,
  textOf,
  transcriptFromMessages,
} from './lib/prompt.js'

/** Plugin name used by the Loader and by log lines. */
export const name = 'dsh-better'

/** This plugin needs the human-command registry; the subagent service is optional at call time. */
export const inject = ['commands']

/** Fallback copy when the row's config supplies no description override. */
const DEFAULT_DESCRIPTION =
  'Deepen the request before you send it: rewrite it the way a top professional in this field would ask it, grounded in this workspace.'

/** Composer hint for the command's free-form input. */
const INPUT_HINT = '<what you want done>'

/**
 * Tools the helper may use. Everything else is removed from its scope, so the
 * helper cannot edit, write, run a terminal, schedule work or delegate.
 */
const DEFAULT_ALLOWED_TOOLS = ['read', 'read_image', 'glob', 'grep', 'bash', 'web_fetch', 'web_search']

/**
 * Five minutes. The composer is locked while a command with input is submitted,
 * so the cap is what bounds a stuck run.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Mount the command.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} [config] - the Loader row's config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'better',
        description: settings.description,
        input: { hint: INPUT_HINT },
        handler: (invocation) => runBetter(ctx, invocation, settings),
      }),
    'dsh-better: /better command',
  )
}

/**
 * Run one `/better` invocation to completion.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} invocation - the command invocation.
 * @param {object} settings - resolved plugin settings.
 * @returns {Promise<{kind: 'success'|'error', text: string}>} the command result.
 */
async function runBetter(ctx, invocation, settings) {
  const agent = invocation?.agent
  if (agent === undefined) return fail('This command needs a live session and none is attached.')
  if (invocation.signal?.aborted) return fail('Stopped before the helper started. Nothing was sent and nothing changed.')

  const request = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
  const transcript = request === '' ? transcriptFromMessages(readMessages(agent)) : ''

  if (request === '' && transcript === '') {
    return fail(
      'Nothing to deepen: this session has no request in it yet. Write the request after the command, as in `/better make the retries idempotent`.',
    )
  }

  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    return fail(
      'The subagent service is not loaded, so /better cannot start its helper. Compose @deepseek-ai/dsh-subagent with the spawn provider, then reload.',
    )
  }

  const task = buildBetterTask({ request, transcript })
  const run = await startHelper(ctx, subagents, agent, task, settings, invocation.signal)
  if (run.error !== undefined) return fail(run.error)

  try {
    const result = await run.activation.result
    const reply = textOf(result?.output)
    const stop = result?.stopReason

    if (stop === 'aborted') {
      if (run.stoppedBy() === 'timeout') {
        return fail(
          `The helper ran for ${Math.round(settings.timeoutMs / 60_000)} minutes without finishing, so it was stopped. Nothing was sent.\n\nSend a narrower request, or raise \`timeoutMs\` in this plugin's config.`,
        )
      }
      return fail('Stopped: the helper was cancelled. Nothing was sent and nothing changed.')
    }
    if (reply.trim() === '') {
      return fail(
        explainEmptyReply(stop, result, settings),
      )
    }

    const parsed = parseImprovedPrompt(reply)
    if (!parsed.found) {
      return fail(
        `The helper answered without the <improved-prompt> block, so there is no rewrite to place in your input box. Its reply is below — copy anything useful from it.\n\n${clip(reply, 6_000)}`,
      )
    }

    return {
      kind: 'success',
      text: parsed.prompt,
    }
  } finally {
    await run.dispose()
  }
}

/**
 * Start the read-only helper Agent and hand it the task.
 *
 * The tool allow-list is installed from an `agent/created` listener: listeners
 * run before creation resolves and before the child's first request is
 * assembled, so the restriction is in place from the first step. The child is
 * started with a caller-owned delivery so no completion notice lands in the
 * parent session.
 *
 * @param {object} ctx - Host plugin context.
 * @param {object} subagents - the subagent service.
 * @param {object} agent - the receiving Agent.
 * @param {string} task - the helper task text.
 * @param {object} settings - resolved plugin settings.
 * @param {AbortSignal} [userSignal] - cancellation owned by the dispatching UI request.
 * @returns {Promise<{error?: string, activation?: object, dispose?: () => Promise<void>}>} the started run.
 */
async function startHelper(ctx, subagents, agent, task, settings, userSignal) {
  const childId = crypto.randomUUID()
  const controller = new AbortController()
  /** Which owner stopped the run, so the command can say why. */
  let stoppedBy
  const stop = (reason, by) => {
    if (controller.signal.aborted) return
    stoppedBy = by
    controller.abort(reason)
  }

  const onUserAbort = () => stop(userSignal?.reason, 'user')
  if (userSignal?.aborted) stop(userSignal.reason, 'user')
  else userSignal?.addEventListener('abort', onUserAbort, { once: true })

  const timer = setTimeout(
    () => stop(new Error(`the helper ran past its ${Math.round(settings.timeoutMs / 60_000)}-minute limit`), 'timeout'),
    settings.timeoutMs,
  )

  const detach = () => {
    clearTimeout(timer)
    userSignal?.removeEventListener('abort', onUserAbort)
  }

  const offCreated = ctx.on('agent/created', (payload) => {
    const child = payload?.agent
    if (child === undefined || child.id !== childId) return
    offCreated()
    try {
      child.ctx.tools.restrict({ allow: [...settings.allowedTools] })
    } catch (error) {
      ctx.logger?.warn?.('dsh-better: could not restrict the helper tools', error)
    }
  })
  const dropCreated = () => {
    try {
      offCreated()
    } catch {
      /* the listener may already be removed by its own match */
    }
  }

  let activation
  try {
    activation = await subagents.startActivation({
      provider: settings.subagentProvider,
      childId,
      label: 'better',
      request: {
        parent: agent,
        prompt: [{ type: 'text', text: task }],
        ...(settings.agentOptions === undefined ? {} : { agentOptions: settings.agentOptions }),
      },
      signal: controller.signal,
      delivery: 'caller',
    })
  } catch (error) {
    detach()
    dropCreated()
    return {
      error: `The helper could not start: ${messageOf(error)}. Check that the subagent provider "${settings.subagentProvider}" is loaded, or set \`subagentProvider\` in this plugin's config.`,
    }
  }

  return {
    activation,
    stoppedBy: () => stoppedBy,
    dispose: async () => {
      detach()
      dropCreated()
      try {
        await activation.dispose()
      } catch (error) {
        ctx.logger?.warn?.('dsh-better: helper cleanup failed', error)
      }
    },
  }
}

/**
 * @param {string} stopReason - the subagent stop reason.
 * @param {object} result - the subagent result.
 * @param {object} settings - resolved plugin settings.
 * @returns {string} a message that says what happened and what to do next.
 */
function explainEmptyReply(stopReason, result, settings) {
  const diagnostic = typeof result?.diagnostic === 'string' ? result.diagnostic.trim() : ''
  const detail = diagnostic === '' ? '' : `\n\n${diagnostic}`
  if (stopReason === 'error' || stopReason === 'failed') {
    return `The helper stopped on an error before it wrote a rewrite.${detail}\n\nTry again; if it repeats, set a different \`provider\`/\`model\` in this plugin's config.`
  }
  if (stopReason === 'max-tokens' || stopReason === 'max_tokens') {
    return `The helper ran out of output tokens before the <improved-prompt> block.${detail}\n\nSend a narrower request, or raise \`maxTokens\` in this plugin's config.`
  }
  return `The helper finished without any text to use.${detail}\n\nTry again, or narrow the request. The current limit is ${Math.round(settings.timeoutMs / 60_000)} minutes.`
}

/**
 * Read the parent session's current model-visible messages.
 *
 * @param {object} agent - the receiving Agent.
 * @returns {readonly unknown[]} messages, or an empty array.
 */
function readMessages(agent) {
  try {
    const session = agent?.session
    if (typeof session?.deriveMessages === 'function') return session.deriveMessages()
  } catch (error) {
    void error
  }
  return []
}

/**
 * @param {string} text - error body.
 * @returns {{kind: 'error', text: string}} an errored command result.
 */
function fail(text) {
  return { kind: 'error', text }
}

/**
 * @param {unknown} error - caught value.
 * @returns {string} a short human-readable message.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return 'no reason was reported'
}

/**
 * @param {string} text - candidate text.
 * @param {number} limit - maximum length.
 * @returns {string} the text, cut when too long.
 */
function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`
}

/**
 * Resolve the Loader row's config into the values this plugin uses.
 *
 * The bundle declares no Config schema, so every field is read defensively and
 * a wrong type falls back to its default instead of failing activation.
 *
 * @param {object} config - raw row config.
 * @returns {object} resolved settings.
 */
function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const provider = string(source.provider)
  const model = string(source.model)
  const reasoningEffort = string(source.reasoningEffort)
  const maxTokens = positiveInteger(source.maxTokens)

  const agentOptions = {}
  // A route is only usable as a pair; a lone half would be silently ignored by
  // the provider, so it is dropped here instead.
  if (provider !== undefined && model !== undefined) {
    agentOptions.provider = provider
    agentOptions.model = model
  }
  if (reasoningEffort !== undefined) agentOptions.reasoningEffort = reasoningEffort
  if (maxTokens !== undefined) agentOptions.maxTokens = maxTokens

  return {
    description: string(source.description) ?? DEFAULT_DESCRIPTION,
    subagentProvider: string(source.subagentProvider) ?? 'spawn',
    timeoutMs: positiveInteger(source.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    allowedTools: stringList(source.allowedTools) ?? DEFAULT_ALLOWED_TOOLS,
    agentOptions: Object.keys(agentOptions).length === 0 ? undefined : agentOptions,
  }
}

/**
 * @param {unknown} value - candidate.
 * @returns {string|undefined} the trimmed non-empty string.
 */
function string(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * @param {unknown} value - candidate.
 * @returns {number|undefined} a positive safe integer.
 */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * @param {unknown} value - candidate.
 * @returns {string[]|undefined} a non-empty list of non-empty strings.
 */
function stringList(value) {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  return list.length === 0 ? undefined : list
}
