---
name: herdr-session-marker
description: Mark every LLM CLI pane in Herdr (Claude Code, Codex, Grok, Antigravity CLI) as a fresh (○) or in-use (●) conversation in the Go to picker, by naming the pane "<tab label> ○/●". Installs per-CLI hooks that keep the mark current (startup and /clear → ○, prompt submit and resume → ●), and bulk-marks existing panes. Use when the user wants to tell unused sessions from in-use ones in Herdr, mark all tabs at once, re-sync marks after renaming tabs, or remove the marks — e.g. 「未使用のセッションがわかるようにして」「全タブに ○● を付けて」「マークを付け直して」「マークを外して」.
---

# Herdr session marker

Herdr's agent status (`idle` / `working` / `done`) says whether an agent accepts input, not whether its conversation is empty: a `done` pane turns `idle` once viewed, so a used session looks the same as a fresh one. This skill adds that missing bit as a pane name.

Why the pane name: in the Go to picker (`prefix+g`), a row's label is the first of pane name → agent name → custom tab name → title. Its agent column uses the detected agent kind before `--display-agent`, and its status column is the fixed status text, ignoring `--state-label`. So only the label can carry a per-pane marker. `herdr agent rename` only accepts `[a-z0-9_-]`, so the pane name is the only place `○`/`●` fit. Tab names stay untouched. Verified on Herdr 0.9.5.

All commands go through one script:

```bash
S=~/.ghq.d/src/github.com/nabinno/agent-skills/herdr-session-marker/scripts/herdr-session-marker
```

First check `HERDR_ENV=1`. Outside Herdr, stop and say so.

## Install hooks (once per machine)

```bash
"$S" install      # "$S" uninstall reverses it
```

This registers `"$S" hook <agent>` in each CLI and backs up each edited file to `*.bak-herdr-session-marker`:

| CLI | File | Events |
|---|---|---|
| Claude Code | `settings.json` in `$CLAUDE_CONFIG_DIR`, `~/.claude-bedrock`, `~/.claude` (those that exist) | `SessionStart`, `UserPromptSubmit` |
| Codex | `${CODEX_HOME:-~/.codex}/hooks.json` | `SessionStart`, `UserPromptSubmit` |
| Grok | `${GROK_HOME:-~/.grok}/hooks/herdr-session-marker.json` | `SessionStart`, `UserPromptSubmit` |
| Antigravity CLI | `~/.gemini/config/hooks.json` (`herdr-session-marker`) & `~/.gemini/antigravity-cli/settings.json` (`statusLine`) | `PreInvocation` + `statusLine` (startup, `/clear`, `/new`, `/resume`) |

The hook maps events to marks:

| Mark | Event |
|---|---|
| ○ | `SessionStart` with source `startup`/`clear` (Claude, Codex) or `new` (Grok: `/new`, `/clear`) |
| ○ | Antigravity CLI `statusLine` when `agent_state` is `idle` with zero tokens / no `current_usage` / no `conversation_title` (fresh startup, `/clear`, `/new`). `agy`'s `SessionStart` hook only fires right before the first model call, so `statusLine` is used instead; any existing `statusLine.command` is wrapped and preserved. |
| ● | `SessionStart` with source `resume`/`compact`/`load` |
| ● | Antigravity CLI `statusLine` with non-zero tokens, `current_usage`, `conversation_title`, or non-idle `agent_state` (including `/resume`, `--conversation`, `--continue`) |
| ● | `UserPromptSubmit` / `PreInvocation` |

The hook does nothing when `HERDR_PANE_ID` is unset. It renames only when the label changes, prints nothing (except `{}` for Antigravity CLI hooks, which require a JSON object; `statusline` stays silent unless wrapping a user command), and always exits 0.

After install, tell the user what still needs doing by hand:
- Running CLIs pick up the hooks on their next start. Claude Code also reloads settings while running.
- Codex may ask to review the new hook in `/hooks`.
- Grok runs global hooks only in trusted folders.

## Mark existing panes

```bash
"$S" sync --dry-run          # preview
"$S" sync                    # apply
"$S" sync --agent codex      # refresh Codex panes only
"$S" sync --others session   # also mark idle non-Claude panes (or: --others fresh)
```

`sync` decides each pane in this order:
1. Codex → ○ if its visible screen still shows the untouched welcome banner and empty input prompt, including when Herdr reports `done` or `idle`.
2. `working` / `blocked` / `done` → ●.
3. Claude with a Herdr session id → ● if its transcript (`<config>/projects/*/<id>.jsonl`) has an `assistant` entry, else ○. A `/clear`-only transcript has no assistant entry.
4. Antigravity CLI (`agy`) → ○ if the recent terminal output shows only the `Antigravity CLI` banner and an empty prompt box, else ●.
5. Other idle agents: Herdr holds no session id for them, so they are skipped unless `--others` is given. Look at the skipped panes and set them one by one:

```bash
herdr agent read <pane_id> --source visible --lines 40   # look for prior conversation
"$S" set <pane_id> fresh|session
```

Re-run `sync` after renaming tabs. The pane name embeds the tab label and otherwise updates only at the next hook event.

## Inspect or remove

```bash
"$S" status           # pane, agent, status, mark, label
"$S" unmark --all     # clear pane names that carry a mark (or: unmark <pane_id>)
```

## Limits

- In a split tab, Herdr labels rows `<tab> · <pane name> · N`, so the tab name appears twice.
- The state dot and the `idle` text in Go to are Herdr's own and cannot change. The `i` filter still lists both ○ and ●. Use `/` search for `○` or `●`.
- A pane name set by hand is replaced by the marker.
