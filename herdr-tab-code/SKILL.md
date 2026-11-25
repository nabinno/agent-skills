---
name: herdr-tab-code
description: Prefix every Herdr tab name with a two-letter code (workspace letter + tab position letter, e.g. "AC oth", "CA cc2") so the Go to picker (prefix+g) can jump to any tab across workspaces with "/", two letters, Enter. Reassigns codes after tabs are added, closed, or reordered, removes them, and keeps herdr-session-marker's ○/● pane names in sync. Use for requests such as 「タブ名にAA・ABのような番号を付けて」「タブ名に2桁の番号を付けて」「タブ番号を振り直して」「番号を外して」「Go to で番号で移動したい」.
---

# Herdr tab codes

Go to has no "type a number to jump" key, but its `/` search matches row labels. A two-letter prefix on each tab name turns that search into a jump: `/` → `a` `c` → `Enter`. Letters are used instead of digits because they stay on the home row and need no reach to the number row. No fork, no config change, no keybinding that collides with Windows Terminal. Verified on Herdr 0.9.5.

Numbering:

| Part | Meaning |
|---|---|
| 1st letter | workspace `number` from `herdr workspace list`: 1=`A`, 2=`B`, ... (1-26) |
| 2nd letter | position among the workspace's tabs in display order: 1=`A`, 2=`B`, ... (1-25, `A`-`Y`) |
| `Z` | tabs whose name (without prefix) equals `--zero`, default `~` (a plain shell) |

Example: workspace 3, first tab → `CA`; workspace 1's plain shell → `AZ`.

`herdr tab list` returns tabs in display order. Its `number` field is an internal counter, not the position, so the script ignores it.

```bash
S=~/.ghq.d/src/github.com/nabinno/agent-skills/herdr-tab-code/scripts/herdr-tab-code
```

First check `HERDR_ENV=1`. Outside Herdr, stop and say so.

## Assign or reassign codes

```bash
"$S" apply --dry-run             # preview
"$S" apply                       # all workspaces
"$S" apply --workspace w4        # one workspace
"$S" apply --zero zsh            # give Z to tabs named zsh instead of ~
```

An existing `AB ` prefix, or an old numeric `12 ` one, is replaced, so re-run `apply` after adding, closing, or reordering tabs (for reordering, see herdr-reorder-tabs). The rest of the name is kept as is.

Skipped with a message, left unchanged:
- a 26th or later non-zero tab in a workspace,
- a workspace numbered 27 or higher.

Tell the user about any skipped tab and offer a fix: close or merge tabs, or rename one to the `--zero` label.

## Remove

```bash
"$S" strip [--workspace <id>] [--dry-run]
"$S" status                      # workspace(number), tab id, label
```

## Session marker

Go to shows the pane name before the tab name, and herdr-session-marker sets pane names to `<tab label> ○/●`. After `apply` or `strip`, the script re-applies each pane's current mark through that skill's `set`, so the label shows the new number. That covers non-Claude panes too, which `sync` would skip. If herdr-session-marker is not next to this skill, this step is skipped.

## Limits

- Search is fuzzy, so `ca` can also match other rows whose names contain `c` then `a`. Check that the intended tab comes first; if not, change the separator (for example `CA:cc2`) in the script.
- A tab whose own name starts with two capital letters and a space (e.g. `OK foo`) is read as already prefixed, and those two letters are replaced.
- New tabs get no code until `apply` runs again.
