# herdr-reorder-tabs

Reorder the tabs of the Herdr session this agent is already running in.

## Ask an agent

「タブを emacs, gpt, cc1 の順に並べ替えて」

The agent lists the tabs in the current workspace and moves only the ones needed. Tabs you did not name stay in their current relative order. It does not create, close, rename, or restart anything.

## Requirements

- The agent is inside Herdr (`HERDR_ENV=1`). Outside Herdr, it stops.
- The running Herdr exposes `tab.move`. Herdr 0.9.5 does, with `tab_id` and a zero-based `insert_index`. Tab IDs are handles, not positions.

The socket call and the checks the agent makes are in `SKILL.md`.
