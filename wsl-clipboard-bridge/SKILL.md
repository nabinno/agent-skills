---
name: wsl-clipboard-bridge
description: Copy text to, or read text from, the Windows clipboard from inside WSL2 without mangling non-ASCII (e.g. Japanese) characters. Use whenever the user asks to copy a draft, message, or generated text "to the clipboard" / "クリップボードに入れて" / "コピーして" so they can paste it into a Windows GUI app (Slack, browser, Outlook, etc.).
---

# WSL2 ↔ Windows clipboard bridge

Goal: move text between a WSL2 agent and the Windows clipboard reliably,
including Japanese and emoji, so the user can paste it into a GUI app running
on the Windows side (Slack, a browser form, Outlook, ...).

```
WSL2 text  ──wsl-copy──▶  C:\Users\Public\.wsl-copy-payload.txt
                          + .ps1 (Set-Clipboard -Encoding UTF8)  ──▶  Windows clipboard ──▶ Ctrl+V in any app
WSL2 stdout ◀──wsl-paste── C:\Users\Public\.wsl-paste-dump.txt
                          ◀── .ps1 (Get-Clipboard -Raw -Encoding utf8) ◀── Windows clipboard
```

## Why not just `clip.exe` / inline `powershell.exe -Command`?

- **`clip.exe` mangles non-ASCII text.** It uses the legacy console codepage,
  not UTF-8, so Japanese text comes out as mojibake (`???` / garbled
  characters) once pasted on the Windows side. Don't use it for anything but
  plain ASCII.
- **Inlining PowerShell through `-Command "..."` gets mangled by the
  invoking shell.** zsh/bash expand `$env:...`-style tokens inside double
  quotes before PowerShell ever sees them (same gotcha documented in the
  sibling `agent-browser-current-browser` skill). Always write the
  PowerShell to a small `.ps1` file under `/mnt/c/Users/Public/` and run it
  with `-File`, never `-Command` with interpolated content.
- **`Get-Clipboard` printed straight to the WSL interop pipe also mangles.**
  Route it through a file written with `Out-File -Encoding utf8` and `cat`
  that file from WSL instead of reading PowerShell's stdout directly.
- **Windows PowerShell 5.1's `utf8` encoding always writes a BOM.** (`pwsh`
  7+'s `utf8NoBOM` isn't available on the `powershell.exe` that ships by
  default.) Strip the leading BOM bytes (`\xef\xbb\xbf`) after reading the
  file back, or downstream WSL tools may choke on it.

## Usage

Ready-made scripts in `scripts/` handle all of the above:

```bash
# Copy text to the Windows clipboard
~/.ghq.d/src/github.com/nabinno/agent-skills/wsl-clipboard-bridge/scripts/wsl-copy "貼り付けたいテキスト"
~/.ghq.d/src/github.com/nabinno/agent-skills/wsl-clipboard-bridge/scripts/wsl-copy path/to/draft.txt
echo "貼り付けたいテキスト" | ~/.ghq.d/src/github.com/nabinno/agent-skills/wsl-clipboard-bridge/scripts/wsl-copy

# Read the Windows clipboard back (e.g. to verify what was copied)
~/.ghq.d/src/github.com/nabinno/agent-skills/wsl-clipboard-bridge/scripts/wsl-paste
```

For a long or multi-line draft, prefer `Write`-ing it to a temp file first
(so quoting/escaping isn't a concern) and passing the file path to
`wsl-copy`, rather than inlining it as a shell argument.

## Verifying a copy succeeded

Don't trust `powershell.exe`'s own stdout for round-trip verification in the
terminal — the interop pipe's display encoding can look mangled even when
the clipboard itself is correct. Verify with `wsl-paste` (which goes through
the file+BOM-strip path) instead of eyeballing raw PowerShell output.

## Known gotchas

- Both scripts share temp files under `/mnt/c/Users/Public/` with the
  `agent-browser-current-browser` skill's convention; they clean up after
  themselves, but avoid running two copies/pastes concurrently in parallel
  sessions.
- Requires WSL2 interop (`powershell.exe` reachable from WSL), which is on
  by default — unlike the mirrored-networking/CDP prerequisites in
  `agent-browser-current-browser`, nothing extra needs enabling for this
  skill.
- If `Set-Clipboard` silently does nothing, check that a Windows clipboard
  manager/security tool isn't blocking programmatic clipboard access.
