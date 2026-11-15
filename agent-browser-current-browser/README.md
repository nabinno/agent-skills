# agent-browser-current-browser

Drive the Chrome or Edge window already open on Windows, from a shell inside WSL2. Existing tabs and login state stay. Several agents can share that browser; each one gets its own background tab.

Use this when the request is about the browser you already have open (「今開いているブラウザで」「現在のブラウザで」), or when it names a Chrome profile or tab group.

## Before the first use

1. Turn on WSL2 mirrored networking. In `C:\Users\<you>\.wslconfig`:

   ```
   [wsl2]
   networkingMode=mirrored
   ```

   Applying it requires `wsl --shutdown`, which closes every WSL session.
2. In the browser you want to drive, open `chrome://inspect/#remote-debugging` and turn remote debugging on. Leave that browser running.
3. From the repository root, run `scripts/sync.sh`.
4. Once per Chrome profile, install the companion extension:

   ```bash
   CB=~/.ghq.d/src/github.com/nabinno/agent-skills/agent-browser-current-browser/scripts/cb
   $CB install-bridge
   ```

   Then in that profile: `chrome://extensions` → Developer mode → Load unpacked → the folder the command printed. Extension id: `haagbfgnipgidagcllndobiiiejdnpjl`. Details are in `cb-bridge/README.md`.

## Ask an agent

- 「今開いているブラウザでカレンダーを確認して」
- 「Work の『調査』グループでこの URL を開いて」

The agent runs `cb new` once, reuses the printed session name, and finishes with `cb <name> done`. Those tabs stay open.

## Run it yourself

```bash
CB=~/.ghq.d/src/github.com/nabinno/agent-skills/agent-browser-current-browser/scripts/cb
$CB new --own-group "資料確認"
$CB <printed-name> open "https://example.com"
$CB <printed-name> snapshot -i
$CB <printed-name> done
```

`done` only detaches. `done --close` closes the tabs that session opened. `$CB <name> show` brings its tab to the front when you want to watch.

Do not drive the browser with a bare `agent-browser connect`. That opens another debugging connection and collides with other sessions. Agent rules for profiles, tab groups, and Slack links are in `SKILL.md`.
