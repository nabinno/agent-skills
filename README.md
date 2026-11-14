# agent-skills

Shared [SKILL.md](https://github.com/anthropics/skills) skills, reused across
Claude Code, Codex, Grok, and Antigravity CLIs — all load the same
`<name>/SKILL.md` format, so one skill here works everywhere via symlinks
instead of copies.

## Layout

Each top-level directory is one skill:

```
<skill-name>/
  SKILL.md        # required: frontmatter (name, description) + instructions
  scripts/        # optional helper scripts
  references/     # optional extra docs loaded on demand
```

## Installing into each CLI

```bash
ghq get nabinno/agent-skills
~/.ghq.d/src/github.com/nabinno/agent-skills/scripts/sync.sh
```

This symlinks every skill here into:

- `~/.claude/skills/<name>` (Claude Code — or `$CLAUDE_HOME` / `$CLAUDE_CONFIG_DIR` if set)
- `~/.codex/skills/<name>` (Codex — leaves the reserved `.system/` subdir alone)
- `~/.grok/skills/<name>` (Grok)
- `~/.gemini/config/skills/<name>` (Antigravity global skills — or `$GEMINI_CONFIG_DIR` if set)
- `~/.agents/skills/<name>` (shared `.agents` workspace skills — or `$AGENTS_HOME` if set)

Re-run `scripts/sync.sh` after adding a new skill directory. It's idempotent
and never overwrites a real (non-symlink) directory that happens to already
exist with the same name.

## Adding a new skill

1. `mkdir -p <skill-name>` and write `<skill-name>/SKILL.md` (see any
   existing skill here for the frontmatter format).
2. `scripts/sync.sh`
3. Commit and push.
