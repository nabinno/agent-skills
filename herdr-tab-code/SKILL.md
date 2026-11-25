---
name: herdr-tab-number
description: Prefix every Herdr tab name with a two-digit number (workspace digit + tab position, e.g. "13 oth") so the Go to picker (prefix+g) can jump to any tab across workspaces with "/", two digits, Enter. Renumbers after tabs are added, closed, or reordered, removes the numbers, and keeps herdr-session-marker's ○/● pane names in sync. Use for requests such as 「タブ名に2桁の番号を付けて」「タブ番号を振り直して」「番号を外して」「Go to で番号で移動したい」.
---

# Herdr tab numbers

Go to has no "type a number to jump" key, but its `/` search matches row labels. A two-digit prefix on each tab name turns that search into a jump: `/` → `1` `3` → `Enter`. No fork, no config change, no keybinding that collides with Windows Terminal. Verified on Herdr 0.9.5.

Numbering:

| Part | Meaning |
|---|---|
| 1st digit | workspace `number` from `herdr workspace list` (1-9) |
| 2nd digit | position among the workspace's tabs in display order (1-9) |
| `0` | tabs whose name (without prefix) equals `--zero`, default `~` (a plain shell) |

`herdr tab list` returns tabs in display order. Its `number` field is an internal counter, not the position, so the script ignores it.

```bash
S=~/.ghq.d/src/github.com/nabinno/agent-skills/herdr-tab-number/scripts/herdr-tab-number
```

First check `HERDR_ENV=1`. Outside Herdr, stop and say so.

## Number or renumber

```bash
"$S" apply --dry-run             # preview
"$S" apply                       # all workspaces
"$S" apply --workspace w4        # one workspace
"$S" apply --zero zsh            # give 0 to tabs named zsh instead of ~
```

An existing `NN ` prefix is replaced, so re-run `apply` after adding, closing, or reordering tabs (for reordering, see herdr-reorder-tabs). The rest of the name is kept as is.

Skipped with a message, left unchanged:
- a 10th or later non-zero tab in a workspace,
- a workspace numbered 10 or higher.

Tell the user about any skipped tab and offer a fix: close or merge tabs, or rename one to the `--zero` label.

## Remove

```bash
"$S" strip [--workspace <id>] [--dry-run]
"$S" status                      # workspace(number), tab id, label
```

## Session marker

Go to shows the pane name before the tab name, and herdr-session-marker sets pane names to `<tab label> ○/●`. After `apply` or `strip`, the script re-applies each pane's current mark through that skill's `set`, so the label shows the new number. That covers non-Claude panes too, which `sync` would skip. If herdr-session-marker is not next to this skill, this step is skipped.

## Limits

- Search is fuzzy, so `13` can also match a row like `21 cc2-3`. Check that the intended tab comes first; if not, change the separator (for example `13:oth`) in the script.
- New tabs get no number until `apply` runs again.
