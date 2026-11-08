---
name: agent-browser-current-browser
description: Connect agent-browser via CDP to the user's already-open Windows Chrome/Edge (not a fresh/headless instance) from inside WSL2, without restarting the browser or closing its tabs. Use whenever the user asks to read, click, or automate something in "the browser I already have open" / "現在のブラウザ" / "既存のブラウザ" (e.g. check Google Calendar, read a page they're logged into) rather than a brand-new agent-browser session.
---

# agent-browser: connect to the current Windows browser via CDP (WSL2)

Goal: drive the user's real, already-open Chrome/Edge window from WSL2 using
agent-browser, so their existing tabs/login state are reused. Do NOT restart
their browser or launch a separate agent-browser profile unless this fails
and the user agrees to a fallback.

## Prerequisites (one-time, already done on this machine)

1. **WSL2 mirrored networking** must be enabled, or `127.0.0.1` inside WSL2
   and on Windows are different network namespaces and the browser's CDP
   port is unreachable.
   - Config file: `C:\Users\<you>\.wslconfig`
     ```
     [wsl2]
     networkingMode=mirrored
     ```
   - Applying this requires `wsl --shutdown` from PowerShell/cmd (via WSL
     interop), which kills **every** WSL session including the current one.
     **Always confirm with the user before running `wsl --shutdown`** — it's
     disruptive. If `ip route show default` reports a NAT-style gateway
     (e.g. `172.18.x.x`) rather than being absent/different, mirrored mode
     is probably off; re-check with the user and the `.wslconfig` file
     before assuming it needs redoing.
   - Verify mirrored mode is active: a plain `curl -sv -m 3 http://127.0.0.1:<port>/`
     from WSL should at least reach something on Windows' loopback (even a
     404/refusal response with "Connected to 127.0.0.1" is TCP-level proof
     it's shared; a hung connection usually means NAT mode, not mirrored).

2. **Remote debugging must be toggled ON in the target Chrome/Edge window**
   by the user, via `chrome://inspect/#remote-debugging` (Chrome 144+). This
   is a runtime UI toggle, not a launch flag — it does NOT require closing
   the browser or any tabs. Ask the user to open that URL and enable it if
   unsure; have them confirm back.
   - Do NOT try to enable this yourself by relaunching the browser with
     `--remote-debugging-port` — that requires fully quitting all browser
     processes first and is a disruptive fallback, not the default path.

## Discovering and connecting

A ready-made helper already exists in the user's dotfiles:
`~/.ghq.d/src/github.com/nabinno/dotfiles/.local/bin/cdp` (Python 3). It:
- Reads `DevToolsActivePort` from the Windows Chrome profile directory
  (resolved via `$CDP_CHROME_USER_DATA_DIR`, `$USER_PROFILE`, or by asking
  Windows for `$env:LOCALAPPDATA` through `powershell.exe` interop and
  converting with `wslpath`).
- Builds `ws://127.0.0.1:<port>/devtools/browser/<uuid>` from that file.
- `cdp --url` prints the discovered WebSocket URL.
- `cdp --check` does a raw TCP reachability check only.
- `cdp` with no flags execs `agent-browser connect <url>`.

Typical flow:
```bash
python3 ~/.ghq.d/src/github.com/nabinno/dotfiles/.local/bin/cdp --url     # sanity check / get the URL
timeout 25 agent-browser connect "$(python3 ~/.ghq.d/src/github.com/nabinno/dotfiles/.local/bin/cdp --url)"
timeout 20 agent-browser tab list                                        # see existing real tabs
timeout 25 agent-browser tab new "https://example.com"                   # open what you need
timeout 20 agent-browser snapshot -i -c                                  # read it
```

Always wrap agent-browser calls in `timeout <seconds>` here: a bad/stale CDP
session can hang indefinitely rather than erroring quickly.

## Known gotchas

- **Chrome's HTTP discovery endpoints (`/json`, `/json/version`, `/json/list`)
  return a bare `404` even when CDP is genuinely enabled and reachable.**
  This is expected with the UI-toggle remote debugging mode — it doesn't
  serve the usual discovery JSON, only the exact WebSocket URL from
  `DevToolsActivePort` works. Don't treat the 404 as "debugging is off";
  treat `cdp --check`'s TCP-level result and an actual `agent-browser
  connect` attempt as the real signals.
- **A stale `agent-browser` daemon from an earlier, unrelated session** can
  own its own separate (headless or headed) Chrome and confuse things. Check
  `ps aux | grep agent-browser` and `ps aux | grep chrome` if a connect
  attempt behaves oddly; kill leftover daemons before retrying.
- **The UUID in `DevToolsActivePort` can go stale** if the toggle was turned
  off and back on. Re-run `cdp --url` to refresh it rather than reusing an
  old value.
- **Windows PowerShell/cmd calls through WSL interop** (`powershell.exe -NoProfile -Command "..."`)
  get mangled by zsh's own `$`-expansion when the command string contains
  `$env:...` or similar in double quotes. Write the PowerShell to a small
  `.ps1` file under `/mnt/c/Users/Public/` and run it with
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Public\foo.ps1"`
  instead of inlining it.
- Many Google Calendar (and similar) week/day views overlay **other
  people's calendars** alongside the account owner's own events. When
  summarizing "my schedule", filter snapshot text for the account owner's
  own name and exclude lines containing `カレンダー: <other person>`;
  otherwise the result is swamped with colleagues' events and recurring
  "予約スケジュール" (booking-page availability holds), which are not real
  individual meetings.

## When this fails

If `agent-browser connect` can't get a usable response even after
confirming both prerequisites, don't silently fall back to a new
agent-browser-owned profile/browser — that changes the user's intent (a
fresh, logged-out browser instead of their real one). Ask the user how they
want to proceed, same as launching a brand-new browser vs. restarting the
existing one with `--remote-debugging-port` are both disruptive and need
explicit confirmation.
