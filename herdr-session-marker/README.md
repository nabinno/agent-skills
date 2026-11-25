# herdr-session-marker

Show in Herdr's Go to picker (`prefix+g`) which LLM CLI panes hold a fresh conversation and which are in use:

```
cc2-1 ○      claude  idle     ← unused or /clear-ed
cc2-2 ●      claude  idle     ← conversation in progress
cc2-3 ●      claude  done
```

Herdr's `done` turns into `idle` once you look at the tab, so idle alone cannot tell a used session from an empty one. This skill sets the pane name to `<tab label> ○` or `<tab label> ●`. Herdr's own status and the tab names are left unchanged.

## Ask an agent

- 「herdr-session-marker のフックを入れて」 — registers hooks in Claude Code, Codex, Grok, and Antigravity CLI.
- 「全タブに ○● を付けて」 — marks the panes that already exist.
- 「タブ名を変えたのでマークを付け直して」 / 「マークを外して」

## Run it yourself

```bash
S=~/.ghq.d/src/github.com/nabinno/agent-skills/herdr-session-marker/scripts/herdr-session-marker
"$S" install                 # hooks for every installed CLI (uninstall to remove)
"$S" sync --dry-run && "$S" sync
"$S" status
"$S" unmark --all
```

## Requirements

- Herdr 0.9.5 or later, with agents running inside it (`HERDR_PANE_ID` set).
- `jq`.
- For bulk marking of idle Claude panes, Herdr's session id for the pane, which Herdr records for Claude Code. For other CLIs, choose with `--others` or `set`.

How the marks are decided and the limits are in `SKILL.md`.
