---
name: herdr-reorder-tabs
description: Reorder existing Herdr tabs to a requested sequence of labels or tab IDs. Use when the user asks to change Herdr tab order, including Japanese requests such as タブを並べ替えて.
---

# Reorder Herdr tabs

First verify `HERDR_ENV=1`. If it is not set to `1`, stop and explain that this agent is outside Herdr. Do not attach to or control another session.

## Discover the current session

```bash
test "${HERDR_ENV:-}" = 1
herdr --help
herdr tab
herdr status
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
```

Use the caller's workspace unless the user selects another one. Match requested labels to the returned `tab_id` values; IDs and tab numbers are opaque handles, not positions. Ask for clarification for duplicate labels or missing targets before mutating. Keep unmentioned tabs in their existing relative order unless the user specifies their placement. Do not create, close, rename, or restart anything to change order.

Prefer an installed CLI reorder command when available. Herdr 0.9.5 exposes `tab.move` in the socket API even though `herdr tab` has no move subcommand. Discover the running schema rather than guessing a command:

```bash
herdr api schema --json | rg -A 45 '"TabMoveParams":'
```

The confirmed parameters in 0.9.5 are `tab_id` and zero-based `insert_index`. A successful move returns the updated tab list. If the running server lacks this method, stop and report the limitation; do not upgrade or restart it.

## Move and verify

Resolve the session socket from `HERDR_SOCKET_PATH` or `HERDR_SOCKET`; if neither exists, use the socket path reported by `herdr status`. Preserve the inherited session context. If sandbox restrictions deny socket access, request execution escalation for the operation instead of changing endpoints.

For a single move, adapt this example using the discovered socket path, tab ID, and desired index:

```python
import json
import socket

socket_path = "/path/from/current-session-status"
tab_id = "<discovered-tab-id>"
insert_index = 1
request_id = "reorder-tab"

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(5)
    connection.connect(socket_path)
    request = {
        "id": request_id,
        "method": "tab.move",
        "params": {"tab_id": tab_id, "insert_index": insert_index},
    }
    connection.sendall((json.dumps(request) + "\n").encode())
    with connection.makefile("r") as replies:
        for line in replies:
            response = json.loads(line)
            if response.get("id") != request_id:
                continue
            if "error" in response:
                raise RuntimeError(response["error"])
            print(json.dumps(response))
            break
        else:
            raise RuntimeError("Herdr disconnected before returning the move result")
```

For several moves, compute the desired full sequence from the live list, then work left to right, moving only tabs whose current position differs. Update the working order from each response before selecting the next move. After an error or timeout, inspect the live order before retrying: the move may already have happened.

Finally run `herdr tab list --workspace "$HERDR_WORKSPACE_ID"` and confirm the actual label sequence. Preserve the focused tab. Report the verified order briefly.

Example: `[emacs, cc1, oth, zsh, gpt]` → `[emacs, gpt, cc1, oth, zsh]` requires just moving the discovered `gpt` tab to index `1`. These labels are an example, not a default ordering.
