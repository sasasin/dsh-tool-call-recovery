# dsh-tool-call-recovery

[日本語](README.ja.md) · [MIT license](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that detects XML tool calls accidentally emitted as assistant text and asks the model to generate a real tool call.

In PTC mode, the model may print `<tool_call><function=read>...</function></tool_call>` instead of calling `run_code`. A provider can return that as ordinary text, ending the turn before the intended operation runs. This plugin supplies a correction before the turn closes and lets DSH continue.

It never executes assistant text. Regenerated calls still pass through DSH's normal validation, permissions, and execution pipeline.

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0-0`; tested with `0.2.2-rc.1`.
- Node.js `^22.19.0 || >=24.0.0`.
- `dsh` and its package manager available on `PATH`.

There are no runtime dependencies or build steps. The repository contains the JavaScript DSH loads, so no `prepare` script or install-time build allowance is needed.

## Install

Replace `<profile>` with a DSH profile such as `web`:

```sh
dsh plugin --profile <profile> add github:sasasin/dsh-tool-call-recovery
```

To pin the initial public release:

```sh
dsh plugin --profile <profile> add github:sasasin/dsh-tool-call-recovery#v1.0.0
```

The bundle registers itself as `tool-call-recovery`. Restart the profile after installation, for example:

```sh
dsh --profile web
```

Installing into a new profile does not select PTC or add a user interface by itself. Choose the desired DSH profile and session mode. By default, the plugin acts only when `run_code` is the session's sole directly callable tool.

## Configuration

Add overrides to `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`$HOME/.dsh/profiles/<profile>/cordis.patch.yml` when `DSH_HOME` is unset):

```yaml
- id: tool-call-recovery
  config:
    enabled: true
    ptcOnly: true
    maxRetries: 2
    maxRecoveriesPerTurn: 20
    maxTextChars: 65536
```

All fields are optional and validated when the plugin loads.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable recovery; set to `false` to disable it. |
| `ptcOnly` | `true` | Act only when `run_code` is the sole declared tool. Set to `false` to also handle native-tool sessions. |
| `maxRetries` | `2` | Consecutive corrections without a successful tool result, from 0 to 10. Zero fails immediately on detection. |
| `maxRecoveriesPerTurn` | `20` | Total corrections in a turn, from 1 to 1000. |
| `maxTextChars` | `65536` | Maximum assistant-text length to inspect, from 1024 to 1048576. Longer text is skipped. |

Unknown options and invalid values fail validation.

## How it works

1. At `agent/turn-stopping`, inspect the latest committed assistant response.
2. Detect standalone trailing XML call blocks outside Markdown examples.
3. Queue a correction with `agent.steer(...)`, explaining that the text was not executed and that PTC calls belong inside `run_code`.
4. Let the model regenerate the call through DSH.

Successful tool results reset the consecutive retry count. Failed results do not. A separate whole-turn budget prevents unbounded corrections. Exhausting either limit ends the turn with an error indicating that work is incomplete.

Corrections are recorded as `user/message` notices with `source.kind: tool-call-recovery`, consecutive and total attempt counts. The original response is preserved. Counts are reconstructed from history on reload.

Recovery guidance and failure messages are currently in Japanese. The plugin does not require a particular model or provider, but correction still depends on the model following that guidance.

## Detection limits

- A supported block starts with `<tool_call>` and contains a named `<function=...>` with a closing `</function>`. A missing outer `</tool_call>` is tolerated.
- Fenced and inline code, blockquotes, indented code, explicitly labelled examples, and calls followed by prose are excluded.
- Reasoning, JSON-only calls, and incomplete function or parameter bodies are not inspected.
- Responses containing both text and actual `tool-call` blocks are skipped to avoid replaying operations that may already have run.
- Only the latest assistant response is checked. The plugin does not repair every malformed format or guarantee task completion.

Strata's `undeclared_tool_calls: call` is optional and can be combined with this plugin. Structured calls use DSH's normal error handling; this plugin handles supported XML remaining in text.

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-tool-call-recovery
```

Remove explicit `tool-call-recovery` overrides from your profile patch and restart DSH.

## Development and validation

```sh
git clone https://github.com/sasasin/dsh-tool-call-recovery.git
cd dsh-tool-call-recovery
npm ci
npm test
npm run test:dsh
npm pack --dry-run
```

Unit tests need only Node.js. Integration tests also need DSH on `PATH`, local sockets, and permission to start DSH child processes. They use a scripted local API and isolated temporary `DSH_HOME` directories; no model, real API key, or access to normal DSH sessions is needed. Results go to the ignored `test-results/integration/` directory.

The integration suite covers recovery, disabled behavior, quoted examples, consecutive exhaustion, three separate recoveries with progress between them, the whole-turn limit, and execution failures. It performs actual DSH PTC reads on temporary files. A previous Linux check with Strata and Qwen also completed a short read after correction; this is not a completion-rate claim for longer workloads or other platforms.

## License

MIT. See [LICENSE](LICENSE).
