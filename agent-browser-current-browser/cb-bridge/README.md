# cb-bridge

Companion Chrome extension for `../scripts/cb`. It lets `cb` confine an
agent-browser session to one Chrome profile and one tab group, which plain
CDP cannot do (CDP knows neither profile names nor tab groups).

`cb` attaches to this extension's service worker over the user's CDP
connection and calls `globalThis.cbBridge.*` (see `background.js`):

| function | purpose |
|---|---|
| `info()` | signed-in email of this profile (matched against Chrome's `Local State` to get the profile name) |
| `snapshot()` | this profile's tab groups and tabs (url, title, group), plus popups opened from grouped tabs |
| `createTab()` | open a background tab inside a group, or in a new group (in the last used window, or a new unfocused one) |
| `activateTab()` | make a tab the active tab of its window; only used by `cb <session> show` on the user's request |
| `closeTabs()` | close tabs `cb` opened itself |

## Permissions

| permission | why |
|---|---|
| `tabs` | read tab URLs/titles to match them with CDP targets |
| `tabGroups` | list groups, create/title a group |
| `storage` | remember popups opened from grouped tabs (`storage.session`, cleared when the browser exits) |
| `identity`, `identity.email` | `getProfileUserInfo()` to tell which profile this instance runs in. No OAuth client is configured, so it cannot obtain tokens |

No content scripts, no host permissions, no network requests, page contents
are never read. A 20 s `chrome.runtime.getPlatformInfo()` keepalive stops
the MV3 worker from going idle, since an idle worker is unreachable over CDP.

The extension id is fixed by the public `key` in `manifest.json`
(`haagbfgnipgidagcllndobiiiejdnpjl`); no private key is kept or needed for
unpacked loading.

## Install / update

```bash
../scripts/cb install-bridge   # prints the folder to load (Windows: %LOCALAPPDATA%\agent-skills\cb-bridge)
```

Then in each profile: `chrome://extensions` → Developer mode → "Load
unpacked" → that folder. After updates, rerun the command and click the
extension's reload icon. Bump `version` when changing the API; `cb` checks
`BRIDGE_MIN_VERSION`.
