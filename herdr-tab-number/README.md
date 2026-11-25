# herdr-tab-number

Give every Herdr tab a two-digit number so you can jump to it from the Go to picker (`prefix+g`) with `/`, two digits, `Enter`:

```
IMS
├ ○ 11 ims:emacs   idle
├ ○ 12 gpt         idle
├ ○ 13 oth         idle     ← / 1 3 Enter
└ ○ 10 ~
ISC
├ ● 21 isc:cc2-1   idle
└ ○ 22 cc2-2       idle
```

The first digit is the workspace, the second the tab's position. Plain shell tabs (`~`) get `0`.

## Ask an agent

- 「タブ名に2桁の番号を付けて」
- 「タブを追加したので番号を振り直して」
- 「タブ番号を外して」

## Run it yourself

```bash
S=~/.ghq.d/src/github.com/nabinno/agent-skills/herdr-tab-number/scripts/herdr-tab-number
"$S" apply --dry-run && "$S" apply
"$S" strip
"$S" status
```

## Requirements

- Herdr 0.9.5 or later, run from inside Herdr.
- `jq`.
- Optional: [herdr-session-marker](../herdr-session-marker/README.md). If its ○/● marks are in use, they are refreshed with the new tab names.

Numbering rules and limits are in `SKILL.md`.
