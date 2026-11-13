/**
 * dsh-better — Client half.
 *
 * The Host half runs `/better` and returns the deepened prompt as the
 * command's result text. This half is what turns that result into the thing
 * pi-better made famous: the rewrite sitting in your input box, ready to edit
 * and send.
 *
 * It also draws one status row while a run is in flight, so a locked composer
 * says what it is waiting for.
 *
 * @module @haroon0x/dsh-better/client
 */
window.__ModuleLoader__.load({
  id: '@haroon0x/dsh-better',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace and fallback copy; the Web client may override it. */
    const NS = 'dsh-better'
    const DEFAULTS = {
      'notice.inBox': 'The deepened prompt is in your input box. Edit it, then press Enter to send.',
      'notice.keptDraft': 'The deepened prompt is in your input box, above what you had typed.',
      'notice.failed': 'The deepened prompt arrived but could not be placed in the input box. It is in the /better row above.',
      'status.running': 'Deepening your prompt against this workspace…',
    }

    /** Command name this half serves. */
    const COMMAND = 'better'

    /** The status row's slot: full-width entries above the composer card. */
    const DOCK = 'conversation.input.dock'

    /** How long to wait for the composer to release the finished command line. */
    const SETTLE_TIMEOUT_MS = 8_000
    const SETTLE_STEP_MS = 60

    let translate = (key) => DEFAULTS[key] ?? key

    const STYLE = `
.dshb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 2px 2px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
.dshb-pulse {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
  animation: dshb-pulse 1.4s ease-in-out infinite;
}
.dshb-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes dshb-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dshb-pulse { animation: none; opacity: 0.9; }
}
`

    /** True while this session is running a `/better` submission. */
    const isRunning = (state) =>
      state?.phase === 'submitting' && state?.claim?.name === COMMAND

    /** One animated row that explains why the composer is locked. */
    function StatusRow({ useInput }) {
      const running = typeof useInput === 'function' ? useInput(isRunning) : false
      if (running !== true) return null
      return h(
        'div',
        { className: 'dshb-row', role: 'status', 'aria-live': 'polite' },
        h('span', { key: 'pulse', className: 'dshb-pulse', 'aria-hidden': 'true' }),
        h('span', { key: 'label', className: 'dshb-label' }, translate('status.running')),
        h('style', { key: 'style' }, STYLE),
      )
    }


    /**
     * Log one contained failure; a broken composer lookup must never break the page.
     *
     * @param {string} message - what failed.
     * @param {unknown} error - the caught value.
     * @returns {void}
     */
    function report(message, error) {
      try {
        console.warn(`[dsh-better] ${message}`, error)
      } catch {
        /* logging is best effort */
      }
    }

    /**
     * Put a finished rewrite into one session's composer.
     *
     * The submit transaction clears the command line right after the Host
     * acknowledges it, so the write waits for the machine to return to
     * `plain`; text typed during the wait is kept below the rewrite.
     *
     * @param {object} ctx - Client plugin context.
     * @param {string} sessionId - the session the command ran in.
     * @param {string} text - the deepened prompt.
     * @returns {void}
     */
    function deliver(ctx, sessionId, text) {
      const sessions = ctx.get('sessions')
      if (sessions === undefined) return

      let actx
      try {
        actx = sessions.scope(sessionId)
      } catch {
        return
      }
      if (actx === undefined) return

      const conversation = actx.get('conversation') ?? ctx.get('conversation')
      if (conversation === undefined) return

      let input
      try {
        input = conversation.input.for(actx)
      } catch (error) {
        report('no input facade for this session', error)
        return
      }
      if (input === undefined) return

      whenSettled(input, (state) => {
        const existing = typeof state?.draft === 'string' ? state.draft.trim() : ''
        try {
          input.setDraft(existing === '' ? text : `${text}\n\n${existing}`)
          input.notify('info', translate(existing === '' ? 'notice.inBox' : 'notice.keptDraft'))
          if (typeof input.focus === 'function') input.focus()
        } catch {
          input.notify('error', translate('notice.failed'))
        }
      })
    }

    /**
     * Run once the input machine is back to `plain` (or when the wait runs out).
     *
     * @param {object} input - the session's input facade.
     * @param {(state: object|undefined) => void} run - the write to perform.
     * @returns {void}
     */
    function whenSettled(input, run) {
      const started = Date.now()
      const attempt = () => {
        let state
        try {
          state = input.state?.getSnapshot?.()
        } catch {
          state = undefined
        }
        if (state !== undefined && state !== null && state.phase !== 'plain' && Date.now() - started < SETTLE_TIMEOUT_MS) {
          setTimeout(attempt, SETTLE_STEP_MS)
          return
        }
        run(state)
      }
      setTimeout(attempt, SETTLE_STEP_MS)
    }

    return {
      inject: ['slots'],

      /**
       * @param {object} ctx - Client plugin context.
       * @returns {void}
       */
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          try {
            locale.register(NS, 'en', DEFAULTS)
            const bound = locale.bind(NS)
            if (typeof bound === 'function') {
              // The bound dictionary wins when it has the key; the built-in copy
              // covers a locale that has not been translated yet.
              translate = (key, params) => {
                try {
                  const value = bound(key, params)
                  return typeof value === 'string' && value !== '' ? value : DEFAULTS[key] ?? key
                } catch {
                  return DEFAULTS[key] ?? key
                }
              }
            }
          } catch (error) {
            report('locale registration failed', error)
          }
        }

        ctx.effect(
          () =>
            ctx.on('command/executed', (sessionId, commandName, result) => {
              if (commandName !== COMMAND) return
              if (result?.kind !== 'success') return
              const text = typeof result.text === 'string' ? result.text.trim() : ''
              if (text === '') return
              deliver(ctx, sessionId, text)
            }),
          'dsh-better: move the rewrite into the composer',
        )

        ctx.slots.inject(DOCK, () =>
          ctx.slots.register({ name: DOCK, id: 'dsh-better-status', order: 60 }, StatusRow),
        )
      },
    }
  },
})
