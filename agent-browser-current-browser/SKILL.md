---
name: agent-browser-current-browser
description: Connect agent-browser via CDP to the user's already-open Windows Chrome/Edge (not a fresh/headless instance) from inside WSL2, without restarting the browser or closing its tabs. Use whenever the user asks to read, click, or automate something in "the browser I already have open" / "現在のブラウザ" / "既存のブラウザ" (e.g. check Google Calendar, read a page they're logged into) rather than a brand-new agent-browser session. Also use it when the user names a Chrome profile or tab group to work in (e.g. "Work の『調査』グループで"), or when several agents use the browser concurrently.
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

`cdp --url` only prints the URL (no connection), but **do not connect to it or
drive the browser with bare `agent-browser connect` / `agent-browser <cmd>`**:
every direct connection makes Chrome ask for permission again, and bare
sessions collide. Use `cb` (next section).

## Concurrency: always use your own pinned session (via `cb`)

Several agents (parallel Claude Code sessions, subagents, Codex, …) may be
attached to the same real Chrome at once. Bare `agent-browser` commands all
go to the shared **`default` session**: one daemon, one "active tab", one set
of `@eN` refs. Two agents there will navigate each other's tab, invalidate
each other's refs, and `close`/kill each other's daemon. That is the
"バッティング" failure mode.

Fix: each agent gets its own `--session` (separate daemon + refs) and
`--pin-tab` (its own tab in the shared Chrome; other sessions get `tab_locked`
if they try to take it, and user-opened tabs never steal focus from it).
The wrapper `scripts/cb` (next to this file) does this for you:

```bash
CB=~/.ghq.d/src/github.com/nabinno/agent-skills/agent-browser-current-browser/scripts/cb
$CB new                                   # -> prints e.g. cb-1109233337-daed4a; opens a pinned background tab
                                          #    in its own tab group "🤖 cb-1109233337-daed4a"
$CB cb-1109233337-daed4a open "https://example.com"
$CB cb-1109233337-daed4a snapshot -i -c
$CB cb-1109233337-daed4a click @e3
$CB cb-1109233337-daed4a done             # detach; the tabs stay open for the user to review
```

Defaults:
- **`cb new` works in its own tab group.** With no options it creates a new
  group "🤖 cb-…" in the **last active profile** (the profile a plain new
  tab would open in), same as `--own-group`. Give it a task name when one is
  obvious: `cb new --own-group "資料確認"`. If cb-bridge isn't loaded in that
  profile (or nowhere), it falls back to an ungrouped tab and says so on
  stderr. `cb new --no-group` asks for an ungrouped tab explicitly.
- **`done` does not close tabs.** It only detaches the session; the tabs it
  opened stay open (in their group) so the user can review the work. Tell
  the user which group/tabs are left open. `done --close` closes the tabs cb
  opened — use it only when the user asks for cleanup.

Rules:
- Run `cb new` **once per task** and reuse the printed name **literally** in
  every later command. Each tool call is a fresh shell, so `export
  AGENT_BROWSER_SESSION=...` does not persist; and don't derive it from cwd
  (`session id --scope worktree`) — parallel agents often share a cwd and
  would collide on the same name.
- If you spawn subagents that use the browser, have each run its own
  `cb new`; never hand one session name to two concurrent workers.
- Stay in your pinned tab. Use `open <url>` to navigate it. Use `tab new`
  only if you really need a second tab; leave it open at the end like the
  others (close it with `tab close` only if it's clearly throwaway, e.g. a
  failed load, or the user asks).
  `tab list` shows the user's/other agents' tabs too — read-only info, don't
  switch into them unless the user asked you to work in a specific existing tab.
- If a command returns `tab_gone` (the user closed your tab), recover with
  `$CB <name> tab new <url>`; don't fall back to another tab.
- Always finish with `$CB <name> done` (tabs stay open; no `--close` unless
  the user asks). Never run `agent-browser close --all`
  (cb refuses `--all`), and never use the `default` session.
- `cb` already wraps each call in `timeout` (`CB_TIMEOUT`, default 25s);
  raise it for slow pages, e.g. `CB_TIMEOUT=60 $CB <name> wait --load networkidle`.
- Cookies/login state are shared (same Chrome profile), so concurrent agents
  logging in/out of the same site can still affect each other — avoid
  login/logout flows in parallel.
- `[agent-browser] launched browser` on `cb new` refers to the session daemon;
  it is attached to the real Chrome (confirm with `tab list` showing the
  user's tabs).

### Background only: never take the user's focus

The user keeps working while agents run, with the Windows taskbar on
auto-hide. Bringing a Chrome tab/window to the front steals their focus and,
when Windows refuses the foreground change, flashes Chrome's taskbar button,
which pops the hidden taskbar up — with several agents, constantly. So cb
works **entirely in background tabs**:

- Tabs are created in the background, and sessions are bound to tabs by
  pre-writing agent-browser's pin file and restarting the session daemon.
  agent-browser's own `tab <tN>` / `tab new` call `Page.bringToFront`, so
  cb intercepts them. Never call bare `agent-browser … tab …`,
  `agent-browser connect`, or CDP `Target.activateTarget` /
  `Page.bringToFront` yourself.
- Clicks, typing, snapshots and screenshots all work on hidden tabs. A tab
  that has never been shown drops pointer input, so before input commands
  cb renders one frame via a 1×1 screenshot (no activation; ~0.1–1 s, at
  most every 30 s per tab).
- `$CB <name> show` brings the session's tab to the front of its window.
  Use it **only when the user asks** to see it ("見せて").
- Remaining unavoidable cases: a page that opens a popup window (e.g. an
  OAuth login) may appear in front, and agent-browser may activate a tab it
  finds unresponsive to revive it.

### One connection to Chrome: cb-hub

With the UI-toggle remote debugging, Chrome asks **"Allow remote debugging?"
for every new CDP connection**. cb and every agent-browser daemon therefore
connect through `scripts/cb-hub.mjs`, a local multiplexer that holds the
single connection to Chrome. The user approves once; it stays valid until
Chrome quits or debugging is turned off (then the next cb command starts a new
hub and Chrome asks once more).

- cb starts the hub on demand and prints a note asking the user to approve.
  If the dialog is denied/dismissed or times out, cb says so — tell the user
  and retry only after they agree (every retry shows the dialog again).
- `$CB hub status|start|stop`. Don't stop it without a reason: the next
  start needs approval again.
- Never connect to Chrome's real endpoint yourself (`cdp --url`,
  `agent-browser connect <chrome url>`, scripts with `new WebSocket(...)`):
  each such connection pops the dialog. For ad-hoc CDP, use the hub URL from
  `~/.cache/cb/hub.json` (`url`).
- Security: the hub listens on 127.0.0.1 with a random token in its path
  (`hub.json`, mode 0600) and refuses `Browser.close`/`Browser.crash`. With
  WSL mirrored networking, Windows-side processes can reach 127.0.0.1 too;
  the token is what keeps them out. The user accepted this trade-off
  (2026-11-10) in exchange for not being asked on every connection.

## Scoping to a Chrome profile and tab group

The user keeps several Chrome profiles (e.g. Work, Personal) in one
browser, and groups tabs by task. A session can be confined to **one profile
and one tab group**. Prefer this whenever the user names a profile or group
("Work の『調査』グループで…").

```bash
$CB profiles                                    # profiles, cb-bridge status, tab groups
$CB new --group "調査" --profile Work            # main use: work in the user's existing group
$CB new                                         # default: own group "🤖 cb-…" in the last active profile
$CB new --own-group --profile Work               # own group in a specific profile (background tab)
$CB new --own-group "資料確認" --profile Work --new-window    # own group in a separate window
```

- `--profile` accepts the Chrome profile name (`Work`), the signed-in email,
  or just its domain (`example.com`). Without `--profile`, `--group` searches all
  profiles and errors if the title is ambiguous. `--profile` alone implies
  `--own-group`. Titles must match exactly; on a miss, run `cb profiles` and
  show the user the real group names instead of guessing.
- In scope = tabs in the group, tabs cb opened for the session, and
  popups/tabs opened *from* an in-scope tab (e.g. OAuth popup windows, which
  can't be grouped). `tab list` shows only these; `tab <tN>` to anything
  else fails, and so does any command while the session's tab has left the
  scope (e.g. the user dragged it out of the group).
- **Leaving the scope**: if the task truly needs a tab outside it, ask the
  user. Only after they explicitly agree, run `$CB <name> allow <tN>` (get
  `tN` from bare `agent-browser --session <name> tab list`). Never use
  `allow` on your own initiative.
- `tab new [url]` creates the tab inside the group. `tab close` and
  `done --close` only close tabs cb opened; the user's own tabs in the group
  are never closed (ask the user if something should be closed). Plain
  `done` closes nothing. In an existing
  group, prefer `tab new <url>` over `open <url>` unless the user wants
  you to navigate one of their tabs.
- An own group goes into the profile's last used window as a background
  tab group. `--new-window` opens a separate (unfocused) window instead;
  creating a window can still flash the taskbar, so only use it when the
  user asks for one.
- Several agents can work in the same group or window at the same time;
  each stays on its own background tab, and a tab pinned by another session
  is refused with `tab_locked`.
- If the same URL+title is open both inside and outside the group, cb can't
  tell which tab is which (it doesn't have the `debugger` permission) and
  refuses to act on it ("ambiguous"). Ask the user to close the duplicate.
- Tabs on `chrome://` pages (e.g. an empty New Tab in the group) are
  invisible to agent-browser; if the group only has those, cb works in a
  fresh tab inside the group.
- This is a guardrail against mistakes, not a security boundary: the CDP
  connection itself can control the whole browser.

### cb-bridge extension (one-time setup per profile)

CDP doesn't expose profile names or tab groups, so scoping uses the small
companion extension in `cb-bridge/` (MV3; permissions `tabs`, `tabGroups`,
`storage`, `identity`, `identity.email`; no content scripts, no host
permissions, no network). `cb` calls it over CDP. See `cb-bridge/README.md`.

1. `$CB install-bridge` copies it to `%LOCALAPPDATA%\agent-skills\cb-bridge`.
2. The **user** loads it once in each profile: `chrome://extensions` →
   Developer mode → "Load unpacked" → that folder (id
   `haagbfgnipgidagcllndobiiiejdnpjl`). After updating the extension, rerun
   step 1 and have the user click its reload icon; cb refuses outdated
   versions.
3. `$CB profiles` should show `●` for that profile. `○` means the profile is
   not open or the extension isn't loaded there; the profile must be signed
   in to Chrome (identified by email against `Local State`).

Managed (Google Workspace) profiles may block Developer mode or unpacked
extensions by policy; then scoping isn't available there — `cb new` falls
back to an ungrouped tab by itself (or use `cb new --no-group`); tell the user.

## Slack links open in the browser, not the desktop app

Slack permalinks (`https://<ws>.slack.com/archives/C…/p…?thread_ts=…`) normally
hand off to the desktop app via `slack://`. `cb <name> open|goto|navigate <url>`
and `cb <name> tab new <url>` rewrite them automatically to the web client,
`https://app.slack.com/client/<team>/<channel>[/thread/<channel>-<thread_ts>]`,
so just pass the permalink as is.

- The team id is read once from the web client's `localStorage.localConfig_v2`
  in the session's tab (cb briefly opens `https://app.slack.com/client`) and
  cached in `~/.cache/cb/slack-teams.json` (workspace host → `T…`/`E…`).
  Delete that file if a workspace is added or ids look wrong.
- If the profile isn't signed in to that workspace, cb warns and opens the
  permalink unchanged.
- A reply permalink opens its thread pane (Slack's web URL can't highlight a
  single reply); a channel link opens the channel.

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
  `agent-browser session list` / `ps aux | grep agent-browser` if a connect
  attempt behaves oddly. **Other `cb-*` sessions may belong to agents running
  right now — never kill them.** Only clean up your own session (`cb <name>
  done`); for anything else, ask the user first.
- **Repeated "Allow remote debugging?" dialogs** mean something bypassed
  cb-hub (see above). `CB_NO_HUB=1` makes cb connect directly; debugging only.
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
