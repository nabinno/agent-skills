---
name: agent-plugin-fanout
description: Install one official marketplace plugin onto Claude Code, Codex, Grok Build, and Antigravity (agy), and leave each host pointed at that marketplace for later updates. Use when the user wants the same plugin on every local agent CLI, wants the publisher's plugin instead of a community or npx skills port, or says 公式プラグインを一括で入れて / 本家を各CLIに適用して / 野良をやめて本家に差し替えて. Slash command /agent-plugin-fanout.
---

# Install one official plugin on every local CLI

The publisher's marketplace is the source. A community fork, a mirror, or `npx skills add <some-fork>` does not follow that publisher's updates. If the user names one of those, find the publisher's own marketplace and plugin name, tell them which source you are using, and install that.

Install only the named plugin. A marketplace can contain other plugins. Two marketplaces can use the same plugin name. The selector is `plugin@marketplace` for the marketplace the user chose.

## Run

`SKILL_DIR` is the directory that contains this file.

```bash
python3 "$SKILL_DIR/scripts/fanout.py" \
  --marketplace <owner/repo-or-git-url> \
  --plugin <plugin-name>
```

`--marketplace cursor/plugins --plugin pstack` is the shape. Substitute the publisher and plugin the user asked for.

The script skips a CLI that is not on PATH. It does not install the CLI. It calls the binaries on PATH, not shell aliases.

Add `--remove-shadows` only when the user asked to replace an unofficial copy of this same plugin. That deletes real directories under the user skills folders whose names match skills shipped inside the plugin, and drops those names from `~/.agents/.skill-lock.json`. It leaves symlinks in place.

Add `--refresh` when the user asked to pull the current marketplace version, including the Antigravity copy.

`--dry-run` prints the same JSON without installing.

## Report

Stdout is one JSON object. Report each host from that object. Include the version, the `update` command, and whether the action was `already-installed`, `installed`, or `skipped`. If `ok` is false, include `command` and `stderr` for that host and do not say that host is installed.

A new session picks up a plugin installed during this one.

## What each host does

Claude Code, Codex, and Grok Build record the marketplace in their own config, then install `plugin@marketplace`. Claude also gets `autoUpdate: true` on that marketplace in `~/.claude/settings.json` unless `--no-autoupdate` is set. Grok's marketplace name comes from the repo name in `~/.grok/config.toml`, which can differ from the `name` inside the publisher's marketplace file. Codex and Claude use the publisher's marketplace name.

Antigravity has no marketplace install. After Claude succeeds, the script runs `agy plugin import claude`, then uninstalls plugins that import added other than the requested plugin and plugins that were already listed. The agy result is a copy. Its `update` line is `agy plugin import claude`, run after Claude itself has updated.

User skill directories with the same names as the plugin's skills are loaded ahead of the plugin. The `shadows` array lists those real directories. Symlinks are not shadows.
