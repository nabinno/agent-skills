# herdr-tab-code

Give every Herdr tab a two-letter code so you can jump to it from the Go to picker (`prefix+g`) with `/`, two letters, `Enter`:

```
IMS
├ ○ AA ims:emacs   idle
├ ○ AB gpt         idle
├ ○ AC oth         idle     ← / a c Enter
└ ○ AZ ~
ISC
├ ● BA isc:cc2-1   idle
└ ○ BB cc2-2       idle
```

The first letter is the workspace (1=A, 2=B, ...), the second the tab's position. Plain shell tabs (`~`) get `Z`. Old numeric prefixes (`13 `) are replaced on the next `apply`.

## Ask an agent

- 「タブ名にAA・ABのような番号を付けて」
- 「タブを追加したので番号を振り直して」
- 「タブ番号を外して」

## Run it yourself

```bash
S=~/.ghq.d/src/github.com/nabinno/agent-skills/herdr-tab-code/scripts/herdr-tab-code
"$S" apply --dry-run && "$S" apply
"$S" strip
"$S" status
```

## Requirements

- Herdr 0.9.5 or later, run from inside Herdr.
- `jq`.
- Optional: [herdr-session-marker](../herdr-session-marker/README.md). If its ○/● marks are in use, they are refreshed with the new tab names.

Numbering rules and limits are in `SKILL.md`.
