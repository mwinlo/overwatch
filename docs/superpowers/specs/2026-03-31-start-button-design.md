# Start Button + Browser Open — Design Spec

**Date:** 2026-03-31
**Goal:** Add a Start button to stopped port map cards that spawns the project's dev server and opens it in the browser once the port is responding.

## Server: `POST /api/start/:name`

1. Look up project in registry by name — 404 if not found
2. Check if port is already in use via `checkPort()` — 409 if already running
3. Create log directory `~/.overwatch/logs/` if it doesn't exist
4. `spawn(command, { cwd: expandedPath, shell: true, detached: true, stdio })` — stdout/stderr piped to `~/.overwatch/logs/<name>.log` (overwritten each start)
5. `child.unref()` so Overwatch can restart without killing the dev server
6. Poll `checkPort(port)` every 500ms, up to 30s timeout
7. On port alive: use `execFile('open', ['http://localhost:<port>'])` (safe — no user input in args) and return `{ success: true, pid, port, opened: true }`
8. On timeout: return `{ success: true, pid, port, opened: false, message: 'started but port not responding yet' }`
9. Track spawned PID in an in-memory `Map<name, pid>` for awareness (not critical — kill still works via port lookup)

**Security note:** The `spawn` call uses `shell: true` because commands like `npm run dev` require shell interpretation. The command string comes from the registry file (`~/.dev-registry.json`), which is user-authored local config — not external input. The browser open uses `execFile` with a hardcoded command and validated port integer.

## Client: Start button on stopped port cards

- Stopped cards get a **Start** button (green accent, same style family as existing action buttons)
- On click: button text changes to "Starting...", button disabled, fetch `POST /api/start/:name`
- On success with `opened: true`: button briefly shows "Opened" then disappears on next poll (card flips to Running)
- On success with `opened: false`: button shows "Started" (browser didn't open, but process is running)
- On error: button shows error text for 3s then resets to "Start"

## Log directory

- `~/.overwatch/logs/` — one file per project (`<name>.log`), overwritten on each start
- No log viewer in the UI — file-based for debugging startup failures

## Files changed

- **`server.js`** — add `POST /api/start/:name` endpoint, log directory setup
- **`public/index.html`** — add Start button to stopped port cards in `buildPortCard()`

No changes to `registry.js`.
