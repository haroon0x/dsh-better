# dsh-better

Put `/better` in front of a request and your DeepSeek Harness rewrites it into the version a top
professional in the field would ask for — with facts from your own code, files and logs in it. The
rewrite lands in your input box, so you read it before anything runs.

It is a port of [`pi-better`](https://github.com/nicobailon/pi-better) by [Nico Bailon](https://github.com/nicobailon)
to the DeepSeek Harness plugin system, built on the "Depth" prompt from Felix Rieseberg's
[How to be more ambitious: A tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#-depth).

## Why

Ask a model to "make this better" and it usually changes its vocabulary, not its methods. It works
from whatever summary is already in the chat, does a bigger version of the same task, and then
judges its own result. Felix's four questions fix each of those:

```text
I want a deeper version of this task, not a bigger one. Before rewriting it: (1) say what a top
professional in this field would do here that I'm not asking for; (2) name the rawest material they
would start from instead of what has already been digested for me; (3) name the specific methods
and tools they would use; (4) say what, other than you or me, would show the result is right. Then
rewrite my prompt to ask for exactly that.
```

Those questions only work as well as the material behind the answers, so `/better` starts a
**read-only helper Agent** in your workspace before it answers: it reads the files, greps the calls,
runs `git log`, and names the checks that actually exist here. You get a rewrite that says
`lib/parse.ts:118` instead of "the parsing code".

## Install

The bundle is a normal DSH plugin package: one Host row plus a Web Client half.

```bash
git clone https://github.com/haroon0x/dsh-better.git ~/src/dsh-better
```

Then install the folder into your profile, either way:

- **From the Web GUI** — Settings → Plugins, install the local package
  `~/src/dsh-better`.
- **By asking your agent** — "install the bundle at `~/src/dsh-better`"; it runs the plugin
  manager's `install_bundle` on that absolute path.

Installing writes a link dependency and adds `@haroon0x/dsh-better` to your profile's
`dsh.profile.bundles`. Reload the page once, and `/better` is in the `/` menu.

## Use

```text
/better make the error messages clearer
```

The composer shows one line while the helper works, then your improved prompt replaces the command
line. Edit it, then press Enter. Nothing is sent until you do.

```text
/better
```

With no request, it deepens the task your session is already on — the last thing you asked for plus
any feedback you have given since.

## Configuration

Set fields on the plugin row, in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-better
  name: '@haroon0x/dsh-better'
  config:
    provider: opencode-go          # helper route; omit to inherit this session's
    model: deepseek-v4.1-flash
    reasoningEffort: high
    subagentProvider: spawn         # subagent backend name (default: spawn)
    timeoutMs: 300000               # hard stop for one run (default: 5 minutes)
    allowedTools: [read, glob, grep, bash]   # default: read, read_image, glob, grep, bash, web_fetch, web_search
    description: 'Rewrite this request before I send it.'
```

`provider` and `model` must be set together; a lone half is ignored so the helper inherits the
session's route instead of failing. The bundle declares no Config schema, so a wrong-typed value
falls back to its default rather than failing activation.

## How it works

1. `/better` is a Host command (`ctx.commands.register`). Commands are log-only: the request and its
   rewrite never become model messages, so your context is unchanged.
2. The handler starts a **read-only helper** with the subagent service (`delivery: 'caller'`, so no
   completion notice lands in your session). A tool allow-list is installed from an `agent/created`
   listener — before the child's first request is assembled — so the helper cannot edit, write, run
   a terminal, schedule, or delegate.
3. The helper gets the four questions plus the rules from pi-better's `helper.md`: read the raw
   material first, keep commands quick, never carry the request out, wrap the rewrite in
   `<improved-prompt>`.
4. The handler returns the rewrite as the command's result text.
5. The Client half listens for the Client `command/executed` event, waits for the composer to release
   the finished command line, and writes the rewrite into that session's draft — keeping anything you
   typed meanwhile below it.

## Differences from pi-better

| | pi-better (pi) | dsh-better (DSH) |
|---|---|---|
| Where the rewrite goes | the input box | the input box |
| Helper runs | a separate `pi` process with a copy of the chat | a read-only child Agent with its own session |
| While it runs | you keep chatting | the composer is locked while the command is submitted (DSH runs input-carrying commands synchronously) |
| Progress | a two-row meter, step by step | one status row under the composer |
| Cancel | Esc | stopped by `timeoutMs` |
| `/better-boomerang` | yes | not yet |
| Agent uses it for subagent briefs | via pi-subagents | not yet (planned: a `better_prompt` tool) |

## Limitations

- **The composer is locked while a run is in flight.** DSH submits a command with input as one
  transaction, so the editor is read-only until the handler returns. `timeoutMs` bounds it; the
  default is 5 minutes.
- **No live tool-by-tool progress.** The status row says a run is happening; it does not stream the
  helper's steps.
- **The helper needs the `spawn` subagent backend** (or whatever `subagentProvider` names). Without
  a subagent service, `/better` reports that and does nothing else.
- **`bash` is allowed** so the helper can use `git`, `ls` and `rg`. The prompt forbids changes and
  the edit/write tools are removed, but a shell is a shell.

## Development

```bash
npm test            # node:test, no dependencies
npm run check       # node --check on every runtime file
```

`lib/prompt.js` is pure: prompt assembly, transcript formatting and reply parsing, all testable
without a Harness. `test/plugin.test.js` drives `apply()` with a stub Host context, including the
`agent/created` tool restriction and every failure message.

## Credits

- The "Depth" prompt is Felix Rieseberg's, from
  [his tutorial](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/#depth).
  It is reproduced verbatim in `lib/prompt.js` with attribution.
- `dsh-better` is a port of [`nicobailon/pi-better`](https://github.com/nicobailon/pi-better); the
  helper rules that keep the model reading instead of guessing come from its `helper.md`.

## License

MIT — see [LICENSE](LICENSE).
