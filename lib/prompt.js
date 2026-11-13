/**
 * Prompt assembly and reply parsing for `/better`.
 *
 * Everything here is a pure function over plain data, so the whole file runs
 * under `node --test` without any Harness service. The Host half owns the
 * agent; this module owns only the words.
 *
 * The four questions are Felix Rieseberg's "Depth" prompt from
 * https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#depth
 * and are reproduced verbatim with attribution. dsh-better is inspired by
 * https://github.com/nicobailon/pi-better by Nico Bailon.
 */

/** Opening tag of the one block the rewrite lives in. */
export const PROMPT_TAG = 'improved-prompt'

/** Longest rewrite the command will hand back, in characters. */
export const MAX_PROMPT_CHARS = 20_000

/** Longest per-message slice contributed by the session transcript. */
export const TRANSCRIPT_MESSAGE_CHARS = 3_000

/** Largest transcript the helper is given when the command runs without a request. */
export const TRANSCRIPT_TOTAL_CHARS = 12_000

/** How many trailing messages the transcript may carry. */
export const TRANSCRIPT_MAX_MESSAGES = 12

/**
 * Felix Rieseberg's four questions, verbatim. They are the reason this works:
 * each one closes a different way a model cheats on "make this better".
 */
export const DEPTH_PROMPT = `I want a deeper version of this task, not a bigger one. Before rewriting it: (1) say what a top
professional in this field would do here that I'm not asking for; (2) name the rawest material they
would start from instead of what has already been digested for me; (3) name the specific methods
and tools they would use; (4) say what, other than you or me, would show the result is right. Then
rewrite my prompt to ask for exactly that.`

/**
 * How the helper is told to work. A model handed the four questions answers
 * them from the conversation summary it already has; this block is what makes
 * it open the real files first, and what keeps it from doing the work.
 */
export const HELPER_RULES = `## How to work

1. Gather the raw material first. Read the files this request names and the ones that call them, and check what the project actually contains. Do not rely on the summary above when the source is reachable. Screenshots, logs and git history count as raw material too.
2. Keep every command quick and work to a budget: about a dozen tool calls and two minutes of reading, then answer. Search the project and the paths the request names, never whole home, session-log or cache directories. Give anything that might run long a timeout of 30 seconds or less, and when something times out, narrow it instead of retrying it. When you already have enough to answer, stop reading.
3. Answer the four questions in a few lines each, using concrete facts you found: real file names, real line numbers, real counts, real tool and command names that exist here.
4. Rewrite the request so it asks for exactly that: the deeper version, not a bigger one. Keep my goal and my voice, put the concrete facts in, and say what proves the result is right. It must read as my own request, ready to send as it stands.
5. Never carry the request out. You read, search and reason; you do not edit files, start work, or launch anything. Do not ask me questions — answer with what the workspace shows.
6. Reply in the language I wrote in.

The tools you can use are read-only: read, read_image, glob, grep, bash, web_fetch and web_search. Use bash for the shell, not for changing files.`

/** The exact reply shape the Host half parses. */
export const OUTPUT_CONTRACT = `## What to reply with

Exactly two parts, in this order, and nothing else:

1. Four short answers, numbered (1) to (4), a few lines each.
2. One block, exactly like this, with nothing after the closing tag:

<${PROMPT_TAG}>
the rewritten request, ready to send as it stands
</${PROMPT_TAG}>`

/**
 * Build the task the helper Agent receives.
 *
 * @param {object} input - what to deepen.
 * @param {string} [input.request] - the text the user typed after `/better`.
 * @param {string} [input.transcript] - the tail of the live session, already formatted.
 * @returns {string} the complete helper task.
 */
export function buildBetterTask({ request, transcript } = {}) {
  const ask = typeof request === 'string' ? request.trim() : ''
  const history = typeof transcript === 'string' ? transcript.trim() : ''

  const subject = ask
    ? `This is the request I want deepened:\n\n<request>\n${ask}\n</request>`
    : `I did not restate the request, so take it from my session below — the last thing I asked for, plus any feedback I have given since. Deepen that, not the conversation itself.\n\n<session>\n${history}\n</session>`

  return [
    'First, without asking me anything, find and read the code, files, docs and logs this touches, so your answers rest on them.',
    '',
    DEPTH_PROMPT,
    '',
    HELPER_RULES,
    '',
    subject,
    '',
    OUTPUT_CONTRACT,
  ].join('\n')
}

/**
 * Split the helper's reply into the marked rewrite.
 *
 * @param {unknown} reply - the helper's final assistant text.
 * @returns {{found: boolean, prompt: string, reason: 'ok'|'missing'|'empty'}} the parsed result.
 */
export function parseImprovedPrompt(reply) {
  const text = typeof reply === 'string' ? reply : ''
  const open = text.search(/<improved-prompt>/i)
  if (open === -1) return { found: false, prompt: '', reason: 'missing' }

  const body = text.slice(open + '<improved-prompt>'.length)
  const close = body.search(/<\/improved-prompt>/i)
  const marked = stripFence((close === -1 ? body : body.slice(0, close)).trim())
  if (marked === '') return { found: false, prompt: '', reason: 'empty' }

  return {
    found: true,
    prompt: marked.length > MAX_PROMPT_CHARS ? `${marked.slice(0, MAX_PROMPT_CHARS)}\n\n… (truncated)` : marked,
    reason: 'ok',
  }
}

/**
 * Flatten message content into plain text, keeping only text blocks.
 *
 * @param {unknown} content - one message's content array.
 * @returns {string} the concatenated text.
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Format the tail of a live session for the helper.
 *
 * Only user and assistant text survives: tool traffic is noise for a rewrite,
 * and an empty result tells the caller there is nothing to deepen.
 *
 * @param {readonly unknown[]} messages - `session.deriveMessages()` output.
 * @param {object} [options] - caps.
 * @param {number} [options.maxMessages] - trailing messages to keep.
 * @param {number} [options.maxChars] - transcript character budget.
 * @param {number} [options.perMessageChars] - per-message character cap.
 * @returns {string} the formatted transcript, or an empty string.
 */
export function transcriptFromMessages(messages, options = {}) {
  const maxMessages = positive(options.maxMessages, TRANSCRIPT_MAX_MESSAGES)
  const maxChars = positive(options.maxChars, TRANSCRIPT_TOTAL_CHARS)
  const perMessage = positive(options.perMessageChars, TRANSCRIPT_MESSAGE_CHARS)

  const entries = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = roleOf(message)
    if (role === undefined) continue
    const text = clip(textOf(message.content).trim(), perMessage)
    if (text === '') continue
    entries.push({ role, text })
  }

  /** Keep the newest that fit the budget, restoring chronological order. */
  const kept = []
  let used = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (kept.length >= maxMessages) break
    const entry = entries[index]
    const cost = entry.text.length + entry.role.length + 4
    if (used + cost > maxChars) break
    used += cost
    kept.unshift(entry)
  }

  return kept.map((entry) => `${entry.role}:\n${entry.text}`).join('\n\n')
}

/**
 * @param {unknown} message - one session message.
 * @returns {'USER'|'ASSISTANT'|undefined} the transcript role, or undefined to skip it.
 */
function roleOf(message) {
  if (message === null || typeof message !== 'object') return undefined
  const role = message.role
  if (role === 'user') return 'USER'
  if (role === 'assistant') return 'ASSISTANT'
  return undefined
}

/**
 * @param {string} text - candidate text.
 * @param {number} limit - maximum length.
 * @returns {string} the text, cut with an explicit marker when too long.
 */
function clip(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (truncated)`
}

/**
 * Drop one code fence wrapping the whole block, which models add by habit.
 *
 * @param {string} text - trimmed block body.
 * @returns {string} the body without a wrapping fence.
 */
function stripFence(text) {
  if (!text.startsWith('```') || !text.endsWith('```')) return text
  const withoutOpen = text.slice(3).replace(/^[^\n]*\n/, '')
  return withoutOpen.slice(0, -3).trim()
}

/**
 * @param {unknown} value - candidate.
 * @param {number} fallback - value used when the candidate is unusable.
 * @returns {number} a positive finite number.
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
