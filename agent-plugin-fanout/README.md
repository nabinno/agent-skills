# agent-plugin-fanout

Install one plugin from the publisher's marketplace onto the local agent CLIs, and leave each CLI pointed at that marketplace so a later update follows the publisher.

Claude Code, Codex, and Grok Build install `plugin@marketplace`. Antigravity (`agy`) has no marketplace install. It receives a copy by importing the Claude Code plugins, and the importer removes plugins that import added besides the one you named.

## Ask an agent

「cursor/plugins の pstack を、入っている CLI 全部に本家のまま入れて」

The agent runs `scripts/fanout.py` and reports the JSON summary. A community fork or `npx skills add` port is not the install source when the publisher has a marketplace.

## Command

```bash
python3 ~/.ghq.d/src/github.com/nabinno/agent-skills/agent-plugin-fanout/scripts/fanout.py \
  --marketplace cursor/plugins \
  --plugin pstack
```

`--remove-shadows` deletes real skill directories that reuse the plugin's skill names. It leaves symlinks alone. `--refresh` updates hosts that already have the plugin, including the Antigravity copy. `--dry-run` prints the plan.

The script's JSON `update` field is the command that pulls a later version for that host. Claude also gets `autoUpdate: true` for that marketplace.
