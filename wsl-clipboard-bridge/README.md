# wsl-clipboard-bridge

Copy text to the Windows clipboard from WSL2, and read it back, without breaking Japanese or other non-ASCII text.

`clip.exe` uses a legacy code page, so Japanese text pastes as mojibake. These scripts write a small PowerShell file under `C:\Users\Public` and pass it with `-File`.

## Commands

```bash
COPY=~/.ghq.d/src/github.com/nabinno/agent-skills/wsl-clipboard-bridge/scripts/wsl-copy
PASTE=~/.ghq.d/src/github.com/nabinno/agent-skills/wsl-clipboard-bridge/scripts/wsl-paste

$COPY "貼り付けたいテキスト"
$COPY path/to/draft.txt
echo "貼り付けたいテキスト" | $COPY
$PASTE
```

For a long draft, write it to a file and pass that path to `wsl-copy`. Check the result with `wsl-paste`. PowerShell's own stdout can look garbled in the WSL terminal even when the clipboard is correct.

## Requirements

`powershell.exe` must be reachable from WSL, which it is by default. The two scripts share temp files, so do not run two copies or pastes at the same time.

Ask an agent with 「クリップボードに入れて」 or 「コピーして」 when the text should be pasted into a Windows app. The encoding notes are in `SKILL.md`.
