# Overwatch UI Monitoring Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce visual noise and improve scannability of Overwatch's Sessions and Port Map views so dev servers, Claude sessions, and system resources can be monitored at a glance.

**Architecture:** All work is frontend-focused in `public/index.html` (vanilla HTML/JS/CSS single-file app). Pure utilities (formatters) move into `public/format.js` so Node tests can load them directly. Two tasks (bulk kill-rogues, last-exited tracking) extend the existing Express API in `server.js` and registry polling in `registry.js`. Tests use Node's built-in `node:test` runner, matching the existing suite in `test/`.

**Tech Stack:** Vanilla HTML/JS/CSS, Node.js, Express, WebSocket, `node:test`.

---

## File Structure

**Modified files:**
- `public/index.html` — all UI changes (styles, DOM structure, render functions, filters). Loads `format.js` via new `<script>` tag.
- `server.js` — new `/api/kill-all-rogues` endpoint (Task 8).
- `registry.js` — in-memory `lastSeen` tracking per project (Task 12). Emits `lastSeenMs` via `getProjectStatuses`.

**New files:**
- `public/format.js` — pure formatter utilities. Exposed both as browser globals and via `module.exports` (dual-load pattern, no `eval`/`new Function`).

**New test files:**
- `test/format.test.js` — unit tests for `formatUptime()`.
- `test/registry-lastseen.test.js` — tests for `lastSeen` tracking.

---

## Task 1: Humanize the uptime format

**Files:**
- Create: `public/format.js`
- Create: `test/format.test.js`
- Modify: `public/index.html` (new `<script>` tag; swap call sites)

**Why first:** Pure function, testable in isolation, zero risk. Immediately improves scannability in both tabs.

- [ ] **Step 1: Create `public/format.js` with dual browser/Node export pattern**

```javascript
// Overwatch formatters. Loaded by the browser via <script src="format.js"> and
// by Node tests via require(). No framework, no bundler.
(function(root) {
  function formatUptime(raw) {
    if (!raw) return '\u2014';
    // ps etime formats: MM:SS | HH:MM:SS | DD-HH:MM:SS
    var days = 0, hours = 0, mins = 0, secs = 0;
    var s = String(raw);
    var dayMatch = s.match(/^(\d+)-(.+)$/);
    if (dayMatch) {
      days = parseInt(dayMatch[1], 10);
      s = dayMatch[2];
    }
    var parts = s.split(':').map(function(x) { return parseInt(x, 10); });
    if (parts.some(isNaN)) return raw;
    if (parts.length === 2) { mins = parts[0]; secs = parts[1]; }
    else if (parts.length === 3) { hours = parts[0]; mins = parts[1]; secs = parts[2]; }
    else return raw;

    if (days > 0) return hours > 0 ? days + 'd ' + hours + 'h' : days + 'd';
    if (hours > 0) return mins > 0 ? hours + 'h ' + mins + 'm' : hours + 'h';
    if (mins > 0) return secs > 0 && mins < 10 ? mins + 'm ' + secs + 's' : mins + 'm';
    return secs + 's';
  }

  var api = { formatUptime: formatUptime };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OverwatchFormat = api;
    // Also hoist commonly-used names to the global scope for convenience in the
    // existing single-file script block.
    root.formatUptime = formatUptime;
  }
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: Write the failing test**

Create `test/format.test.js`:

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatUptime } = require('../public/format.js');

describe('formatUptime', () => {
  it('returns em-dash for falsy input', () => {
    assert.equal(formatUptime(null), '\u2014');
    assert.equal(formatUptime(''), '\u2014');
    assert.equal(formatUptime(undefined), '\u2014');
  });

  it('formats MM:SS as "Xm Ys"', () => {
    assert.equal(formatUptime('05:23'), '5m 23s');
    assert.equal(formatUptime('00:45'), '45s');
    assert.equal(formatUptime('12:00'), '12m');
  });

  it('formats HH:MM:SS as "Xh Ym"', () => {
    assert.equal(formatUptime('01:30:00'), '1h 30m');
    assert.equal(formatUptime('21:32:29'), '21h 32m');
    assert.equal(formatUptime('00:05:00'), '5m');
  });

  it('formats DD-HH:MM:SS as "Xd Yh" when days > 0', () => {
    assert.equal(formatUptime('01-06:26:03'), '1d 6h');
    assert.equal(formatUptime('03-00:00:00'), '3d');
    assert.equal(formatUptime('10-12:34:56'), '10d 12h');
  });

  it('returns raw string unchanged for unparseable input', () => {
    assert.equal(formatUptime('bogus'), 'bogus');
    assert.equal(formatUptime('?'), '?');
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `node --test test/format.test.js`

Expected: all assertions pass.

- [ ] **Step 4: Load `format.js` in `index.html`**

In the `<head>` or just before the existing inline `<script>` block near the bottom of `public/index.html`, add:

```html
<script src="format.js"></script>
```

Place it **before** the inline script so `formatUptime` is defined on `window` when the inline code runs.

- [ ] **Step 5: Replace every `elapsed` render call site with the formatter**

In `public/index.html`, find these lines (grep for `elapsed`):

- Line ~1029 (session metrics render): `+ s.elapsed +`
- Line ~1060 (exited tombstone): `+ escapeHtml(e.elapsed) +`
- Line ~1091 (hog card): `+ (h.elapsed || '\u2014') +`
- Line ~1254 (port card metrics): `['Uptime', p.elapsed || '\u2014']`
- Line ~1370 (rogue card metrics): `['Uptime', r.elapsed || '?']`

Replace each with `formatUptime(X.elapsed)`. Examples:

```javascript
// Port card (was): ['Uptime', p.elapsed || '\u2014']
['Uptime', formatUptime(p.elapsed)]

// Rogue card (was): ['Uptime', r.elapsed || '?']
['Uptime', formatUptime(r.elapsed)]

// Session card (was): '<span class="metric-value">' + s.elapsed + '</span>'
'<span class="metric-value">' + formatUptime(s.elapsed) + '</span>'

// Exited tombstone (was): '<span class="metric-value">' + escapeHtml(e.elapsed) + '</span>'
'<span class="metric-value">' + escapeHtml(formatUptime(e.elapsed)) + '</span>'
```

- [ ] **Step 6: Manual browser verification**

1. Start server: `node server.js`
2. Open http://localhost:4040
3. Session cards show `6m 23s`, `1h 30m`, or `1d 6h`-style strings instead of `05:23` / `01-06:26:03`
4. Switch to Port Map tab — port cards and rogue cards show the same format

- [ ] **Step 7: Commit**

```bash
git add public/format.js test/format.test.js public/index.html
git commit -m "feat: humanize uptime display across all cards"
```

---

## Task 2: Sticky tab bar + sort bar

**Files:**
- Modify: `public/index.html` (CSS only — `.tab-bar` and `.sort-bar` rules)

- [ ] **Step 1: Find the existing CSS rules**

Search `public/index.html` for `.tab-bar {` and `.sort-bar {`. Note the current padding and backgrounds.

- [ ] **Step 2: Update the CSS to make both bars sticky**

Edit `.tab-bar` (find the block that styles it):

```css
.tab-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--bg);
  /* keep existing border-bottom, padding, etc. */
}
```

Edit `.sort-bar`:

```css
.sort-bar {
  position: sticky;
  top: 49px; /* height of tab-bar — see step 3 */
  z-index: 19;
  background: var(--bg);
  padding: 12px 24px;
}
```

- [ ] **Step 3: Measure the tab-bar height in DevTools and set the sort-bar top accordingly**

1. Reload the page
2. Right-click the tab bar → Inspect → look at computed height
3. Set `.sort-bar { top: <measured>px }`

- [ ] **Step 4: Manual browser verification**

1. Scroll the Port Map tab with 10+ cards
2. Tab bar stays at top of viewport
3. Sort bar stays pinned directly under tab bar, no content overlap
4. Repeat on Sessions tab

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: make tab bar and sort bar sticky on scroll"
```

---

## Task 3: Rogue command — show basename, full path in tooltip

**Files:**
- Modify: `public/index.html` (`buildRogueCard` function, `.rogue-command` CSS)

- [ ] **Step 1: Update `buildRogueCard`**

Find `function buildRogueCard(r)` (around line 1342). Replace the command-rendering block:

```javascript
// Was:
var cmd = document.createElement('div');
cmd.className = 'rogue-command';
cmd.textContent = r.command || 'unknown';
card.appendChild(cmd);
```

With:

```javascript
var cmd = document.createElement('div');
cmd.className = 'rogue-command';
var fullCommand = r.command || 'unknown';
var firstToken = fullCommand.split(/\s+/)[0];
var basename = firstToken.split('/').pop() || firstToken;
cmd.textContent = basename;
cmd.title = fullCommand;
card.appendChild(cmd);
```

- [ ] **Step 2: Update `.rogue-command` CSS**

```css
.rogue-command {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--text-secondary); margin-bottom: 10px;
  cursor: help;
  text-decoration: underline dotted rgba(255,255,255,0.15);
  text-underline-offset: 3px;
}
```

- [ ] **Step 3: Manual browser verification**

1. Reload Port Map tab
2. Rogue cards show short names (`rapportd`, `ControlCenter`, `LM Studio Helper (Renderer)`)
3. Hover shows full path + args in tooltip
4. No more long-path overflow in the card

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: show rogue command basename with full path in tooltip"
```

---

## Task 4: Remove duplicated memory display on project cards

**Files:**
- Modify: `public/index.html` (`buildPortCard` function, `.port-metrics` CSS)

- [ ] **Step 1: Remove the Memory cell from the metrics grid**

In `buildPortCard` (around line 1254), change:

```javascript
var pairs = [['Memory', p.treeRssMB + ' MB'], ['CPU', p.cpuPercent + '%'], ['PID', p.pid], ['Uptime', formatUptime(p.elapsed)]];
```

To:

```javascript
var pairs = [['CPU', p.cpuPercent + '%'], ['PID', p.pid], ['Uptime', formatUptime(p.elapsed)]];
```

- [ ] **Step 2: Check `.port-metrics` grid layout**

Read the current `.port-metrics` CSS rule. If it uses 4 columns or `grid-template-columns: 1fr 1fr` with 4 items (2x2), 3 items now renders a 2x2 with one empty cell — that's fine visually. If it was explicitly 4 cols, change to 3:

```css
.port-metrics {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 6px 16px; margin-bottom: 12px; font-size: 12px;
}
```

- [ ] **Step 3: Manual browser verification**

1. Reload Port Map tab
2. Running cards show CPU, PID, Uptime as metric cells
3. `181 / 512 MB (35%)` line + bar below unchanged and is now the only memory display

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: dedupe memory on port cards — keep only limit bar"
```

---

## Task 5: Swap project name and port number hierarchy

**Files:**
- Modify: `public/index.html` (`.port-card-name`, `.port-number` CSS + `buildPortCard` DOM order)

- [ ] **Step 1: Update CSS to promote the name**

Edit the `.port-number` and `.port-card-name` rules:

```css
.port-number {
  font-family: var(--font-mono); font-size: 13px; font-weight: 600;
  color: var(--text-secondary);
}
.port-card.running .port-number { color: var(--green); }
.port-card.rogue .port-number { color: var(--red); }

.port-card-name {
  font-family: var(--font-mono); font-size: 18px; font-weight: 700;
  margin-bottom: 4px; color: var(--text);
}
```

Add:

```css
.port-card-header-right {
  display: flex; gap: 10px; align-items: center;
}
```

- [ ] **Step 2: Reorder DOM in `buildPortCard`**

Find the header-building block (around line 1223). Replace with:

```javascript
// Header: name on left, port + badge on right
var header = document.createElement('div');
header.className = 'port-card-header';
var nameEl = document.createElement('div');
nameEl.className = 'port-card-name';
nameEl.textContent = name;
var headerRight = document.createElement('div');
headerRight.className = 'port-card-header-right';
var portNum = document.createElement('span');
portNum.className = 'port-number';
portNum.textContent = ':' + p.port;
var badge = document.createElement('span');
badge.className = badgeClass;
badge.textContent = badgeText;
headerRight.appendChild(portNum);
headerRight.appendChild(badge);
header.appendChild(nameEl);
header.appendChild(headerRight);
card.appendChild(header);
```

Remove the now-duplicate standalone `nameEl` block below the header (the one with `card.appendChild(nameEl);` at around line 1240).

- [ ] **Step 3: Apply the same header treatment to `buildRogueCard`**

Around line 1347, replace the rogue header block with:

```javascript
var header = document.createElement('div');
header.className = 'port-card-header';
var rogueLabel = document.createElement('div');
rogueLabel.className = 'port-card-name';
rogueLabel.textContent = '? Unregistered';
var headerRight = document.createElement('div');
headerRight.className = 'port-card-header-right';
var portNum = document.createElement('span');
portNum.className = 'port-number';
portNum.textContent = ':' + r.port;
var badge = document.createElement('span');
badge.className = 'port-status-badge rogue';
badge.textContent = 'ROGUE';
headerRight.appendChild(portNum);
headerRight.appendChild(badge);
header.appendChild(rogueLabel);
header.appendChild(headerRight);
card.appendChild(header);
```

Remove the separate `? Unregistered process` label line below the header (now redundant). Keep the command basename from Task 3.

- [ ] **Step 4: Manual browser verification**

1. Reload Port Map tab
2. Name (`overwatch`) is the most prominent text on running cards
3. Port (`:4040`) is small, colored, next to the status badge
4. Rogues: `? Unregistered` + port in header
5. Sort-by-port still orders correctly

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: promote project name over port number on port cards"
```

---

## Task 6: CPU noise reduction on running project cards

**Files:**
- Modify: `public/index.html` (`buildPortCard`)

- [ ] **Step 1: Make CPU conditional**

In `buildPortCard`, change:

```javascript
var pairs = [['CPU', p.cpuPercent + '%'], ['PID', p.pid], ['Uptime', formatUptime(p.elapsed)]];
```

To:

```javascript
var pairs = [['PID', p.pid], ['Uptime', formatUptime(p.elapsed)]];
if (p.cpuPercent >= 0.5) pairs.unshift(['CPU', p.cpuPercent + '%']);
```

- [ ] **Step 2: Manual browser verification**

1. Reload Port Map tab
2. Idle projects show only PID + Uptime
3. Run something CPU-busy in one registered project → CPU cell reappears on next poll

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: hide CPU metric on port cards when below 0.5%"
```

---

## Task 7: Rogue threshold + "Show rogues" toggle

**Files:**
- Modify: `public/index.html` (filter state, sort bar, `renderPortMap`)

**Rule:** hide rogues with `<100 MB` AND `<1% CPU` by default. Add a toggle button.

- [ ] **Step 1: Add filter state**

Near `var portMapSortMode`:

```javascript
var showAllRogues = false;
```

- [ ] **Step 2: Add toggle button to the port-map sort bar**

Find the port-map sort bar:

```html
<div class="sort-bar">
  <button class="sort-btn active" id="pm-sort-port" onclick="setPortMapSortMode('port')">By port</button>
  <button class="sort-btn" id="pm-sort-memory" onclick="setPortMapSortMode('memory')">By memory</button>
  <button class="sort-btn" id="pm-sort-cpu" onclick="setPortMapSortMode('cpu')">By CPU</button>
</div>
```

Replace with:

```html
<div class="sort-bar">
  <button class="sort-btn active" id="pm-sort-port" onclick="setPortMapSortMode('port')">By port</button>
  <button class="sort-btn" id="pm-sort-memory" onclick="setPortMapSortMode('memory')">By memory</button>
  <button class="sort-btn" id="pm-sort-cpu" onclick="setPortMapSortMode('cpu')">By CPU</button>
  <div class="sort-bar-spacer"></div>
  <button class="sort-btn" id="pm-toggle-rogues" onclick="toggleRogues()">Show system rogues</button>
</div>
```

Add:

```css
.sort-bar-spacer { flex: 1; }
```

- [ ] **Step 3: Add `isLowImpactRogue` and `toggleRogues`**

Near `setPortMapSortMode`:

```javascript
function isLowImpactRogue(r) {
  return (r.rssMB || 0) < 100 && (r.cpuPercent || 0) < 1;
}

function toggleRogues() {
  showAllRogues = !showAllRogues;
  document.getElementById('pm-toggle-rogues').classList.toggle('active', showAllRogues);
  lastPortMapStructure = '';
  if (lastPortMapData) renderPortMap(lastPortMapData);
}
```

- [ ] **Step 4: Filter rogues + update button label in `renderPortMap`**

Find the block that pushes rogue items:

```javascript
(rogues || []).forEach(function(r) {
  items.push({
    kind: 'rogue',
    data: r,
    port: r.port,
    mem: r.rssMB || 0,
    cpu: r.cpuPercent || 0,
  });
});
```

Replace with:

```javascript
var hiddenRogues = 0;
(rogues || []).forEach(function(r) {
  if (!showAllRogues && isLowImpactRogue(r)) { hiddenRogues++; return; }
  items.push({
    kind: 'rogue',
    data: r,
    port: r.port,
    mem: r.rssMB || 0,
    cpu: r.cpuPercent || 0,
  });
});
var toggleBtn = document.getElementById('pm-toggle-rogues');
if (toggleBtn) {
  if (showAllRogues) toggleBtn.textContent = 'Hide system rogues';
  else if (hiddenRogues > 0) toggleBtn.textContent = 'Show system rogues (' + hiddenRogues + ')';
  else toggleBtn.textContent = 'Show system rogues';
}
```

Include `showAllRogues` in the structure hash:

```javascript
// Was: var parts = [portMapSortMode];
var parts = [portMapSortMode, showAllRogues ? 'all' : 'impact'];
```

- [ ] **Step 5: Manual browser verification**

1. Reload Port Map tab
2. Low-impact rogues hidden; button reads `Show system rogues (N)`
3. Click → all rogues appear, button becomes `Hide system rogues` + `.active`
4. Click again → filtered view returns
5. High-impact rogues (≥100MB or ≥1% CPU) stay visible regardless

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: hide low-impact rogues by default with toggle"
```

---

## Task 8: "Kill visible rogues" bulk action

**Files:**
- Modify: `server.js` (new endpoint `/api/kill-all-rogues`)
- Modify: `test/server.test.js` (add tests)
- Modify: `public/index.html` (new button + handler)

- [ ] **Step 1: Write failing tests**

Append to `test/server.test.js`:

```javascript
describe('POST /api/kill-all-rogues', () => {
  it('returns 400 when body.ports is missing', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill-all-rogues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('returns 400 when body.ports is empty array', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill-all-rogues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ports: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('returns 200 with results array (no match)', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kill-all-rogues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ports: [65530, 65531] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.results));
    assert.equal(data.results.length, 2);
    data.results.forEach(r => {
      assert.ok('port' in r);
      assert.ok('ok' in r);
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/server.test.js`
Expected: the new tests fail with 404.

- [ ] **Step 3: Implement the endpoint**

Check whether `express.json()` is mounted globally in `createServer` (it should be). If not, add `app.use(express.json());` near the other `app.use` calls.

After the `/api/kill-port/:port` handler (around line 189), add:

```javascript
app.post('/api/kill-all-rogues', (req, res) => {
  const ports = req.body && Array.isArray(req.body.ports) ? req.body.ports : null;
  if (!ports || ports.length === 0) {
    return res.status(400).json({ error: 'ports (non-empty array) is required' });
  }
  const results = ports.map(p => {
    const port = parseInt(p);
    if (isNaN(port)) return { port: p, ok: false, error: 'invalid port' };
    const pid = registry.getPidOnPort(port);
    if (!pid) return { port, ok: false, error: 'no process' };
    try {
      treeKill(pid, 'SIGTERM');
      setTimeout(() => {
        try { process.kill(pid, 0); treeKill(pid, 'SIGKILL'); } catch {}
      }, 2000);
      return { port, ok: true, pid };
    } catch (err) {
      return { port, ok: false, error: err.message };
    }
  });
  res.json({ results });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: all pass.

- [ ] **Step 5: Add button in UI**

In the sort bar (after the rogues toggle from Task 7):

```html
<button class="sort-btn kill-all" id="pm-kill-rogues" onclick="handleKillAllRogues(this)">Kill visible rogues</button>
```

Add CSS:

```css
.sort-btn.kill-all { color: var(--red); }
.sort-btn.kill-all:hover { background: rgba(239,68,68,0.1); border-color: var(--red); }
.sort-btn.kill-all.confirming { background: var(--kill-red); color: white; border-color: var(--kill-red); }
```

- [ ] **Step 6: Implement `handleKillAllRogues` with confirm step**

```javascript
var killAllRoguesConfirmTimer = null;

function handleKillAllRogues(btn) {
  if (!lastPortMapData || !lastPortMapData.rogues) return;
  var visible = lastPortMapData.rogues.filter(function(r) {
    return showAllRogues || !isLowImpactRogue(r);
  });
  if (visible.length === 0) {
    btn.textContent = 'No rogues';
    setTimeout(function() { btn.textContent = 'Kill visible rogues'; }, 2000);
    return;
  }
  if (!killAllRoguesConfirmTimer) {
    btn.textContent = 'Kill ' + visible.length + '? Confirm';
    btn.classList.add('confirming');
    killAllRoguesConfirmTimer = setTimeout(function() {
      killAllRoguesConfirmTimer = null;
      btn.textContent = 'Kill visible rogues';
      btn.classList.remove('confirming');
    }, 3000);
    return;
  }
  clearTimeout(killAllRoguesConfirmTimer);
  killAllRoguesConfirmTimer = null;
  btn.textContent = 'Killing...';
  btn.disabled = true;
  fetch('/api/kill-all-rogues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ports: visible.map(function(r) { return r.port; }) }),
  })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      var okCount = (data.results || []).filter(function(x) { return x.ok; }).length;
      btn.textContent = 'Killed ' + okCount + '/' + visible.length;
      setTimeout(function() {
        btn.textContent = 'Kill visible rogues';
        btn.classList.remove('confirming');
        btn.disabled = false;
        fetchPortMap();
      }, 2000);
    })
    .catch(function() {
      btn.textContent = 'Error';
      setTimeout(function() {
        btn.textContent = 'Kill visible rogues';
        btn.classList.remove('confirming');
        btn.disabled = false;
      }, 2000);
    });
}
```

- [ ] **Step 7: Manual browser verification**

1. Start a test listener: `nc -l 9999 &` (or any process that opens a port)
2. Wait ~3s for next poll
3. `Show system rogues` may be needed to reveal 9999 (it's small)
4. Click `Kill visible rogues` → shows `Kill N? Confirm`
5. Click again within 3s → shows `Killing...` then `Killed N/N`
6. Rogue disappears on next poll
7. If confirm not clicked within 3s, button resets

- [ ] **Step 8: Commit**

```bash
git add server.js test/server.test.js public/index.html
git commit -m "feat: add kill-visible-rogues bulk action with confirm step"
```

---

## Task 9: Compact stopped-card variant + "Running only" filter

**Files:**
- Modify: `public/index.html` (new `.port-card.compact` styles, compact branch in `buildPortCard`, filter state + button)

- [ ] **Step 1: Add compact card CSS**

Near the existing `.port-card` rules:

```css
.port-card.compact {
  padding: 10px 14px;
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px;
  grid-column: 1 / -1;
}
.port-card.compact .port-card-name { font-size: 14px; margin: 0; }
.port-card.compact .port-number { font-size: 12px; }
.port-card.compact .port-card-header {
  margin: 0; flex: 1; display: flex; align-items: center; gap: 12px;
}
.port-card.compact .port-card-actions { padding: 0; margin: 0; }
```

- [ ] **Step 2: Add compact render branch in `buildPortCard`**

Near the top of `buildPortCard`, right after `card.className = cardClass;`:

```javascript
if (!p.running) {
  card.className = 'port-card compact';
  var header = document.createElement('div');
  header.className = 'port-card-header';
  var nameEl = document.createElement('div');
  nameEl.className = 'port-card-name';
  nameEl.textContent = name;
  var portNum = document.createElement('span');
  portNum.className = 'port-number';
  portNum.textContent = ':' + p.port;
  var badge = document.createElement('span');
  badge.className = 'port-status-badge stopped';
  badge.textContent = 'STOPPED';
  header.appendChild(nameEl);
  header.appendChild(portNum);
  header.appendChild(badge);
  card.appendChild(header);

  var actions = document.createElement('div');
  actions.className = 'port-card-actions';
  var startBtn = document.createElement('button');
  startBtn.className = 'port-action-btn start';
  startBtn.textContent = 'Start';
  startBtn.addEventListener('click', function() { handlePortStart(name, startBtn); });
  var cleanBtn = document.createElement('button');
  cleanBtn.className = 'port-action-btn clean';
  cleanBtn.textContent = 'Clean';
  cleanBtn.addEventListener('click', function() { handlePortClean(name, cleanBtn); });
  actions.appendChild(startBtn);
  actions.appendChild(cleanBtn);
  card.appendChild(actions);
  return card;
}
```

This short-circuits the rest of the function for stopped projects. Leave the running branch untouched.

- [ ] **Step 3: Add "Running only" filter state + button**

Near `showAllRogues`:

```javascript
var runningOnly = false;
```

Add button to the port-map sort bar (alongside the rogues toggle and kill-all):

```html
<button class="sort-btn" id="pm-running-only" onclick="toggleRunningOnly()">Running only</button>
```

Handler:

```javascript
function toggleRunningOnly() {
  runningOnly = !runningOnly;
  document.getElementById('pm-running-only').classList.toggle('active', runningOnly);
  lastPortMapStructure = '';
  if (lastPortMapData) renderPortMap(lastPortMapData);
}
```

- [ ] **Step 4: Apply filter in `renderPortMap`**

In the `names.forEach` block:

```javascript
names.forEach(function(name) {
  var p = projects[name];
  if (runningOnly && !p.running) return;
  items.push({ ... });
});
```

Extend the structure hash:

```javascript
var parts = [portMapSortMode, showAllRogues ? 'all' : 'impact', runningOnly ? 'run' : 'any'];
```

- [ ] **Step 5: Manual browser verification**

1. Reload Port Map tab
2. Stopped projects render as single-row compact strips spanning the grid
3. `Running only` hides compact rows; clicking again restores them
4. Start buttons on compact rows still trigger the spawn

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: compact stopped-project rows + Running-only filter"
```

---

## Task 10: Search input + group filter pills

**Files:**
- Modify: `public/index.html` (new filter row, handlers)

- [ ] **Step 1: Add filter row between sort bar and grid**

Insert in the Port Map tab, after `.sort-bar`, before `.portmap-grid`:

```html
<div class="filter-bar" id="pm-filter-bar">
  <input type="text" id="pm-search" class="filter-input" placeholder="Filter by name or description…" oninput="handlePortMapSearch(this.value)">
  <div class="filter-pills" id="pm-group-pills"></div>
</div>
```

Add CSS:

```css
.filter-bar {
  padding: 0 24px 12px;
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
}
.filter-input {
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text); border-radius: 6px;
  padding: 6px 12px; font-family: var(--font-mono); font-size: 12px;
  min-width: 240px; flex: 1; max-width: 420px;
}
.filter-input::placeholder { color: var(--text-secondary); }
.filter-input:focus { outline: none; border-color: rgba(255,255,255,0.2); }
.filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.filter-pill {
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text-secondary); border-radius: 12px;
  padding: 3px 10px; font-family: var(--font-mono);
  font-size: 11px; cursor: pointer; transition: all 0.15s ease;
}
.filter-pill:hover { color: var(--text); }
.filter-pill.active { color: var(--text); background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.4); }
```

- [ ] **Step 2: Add filter state and handlers**

```javascript
var searchQuery = '';
var activeGroup = null;

function handlePortMapSearch(value) {
  searchQuery = value.trim().toLowerCase();
  lastPortMapStructure = '';
  if (lastPortMapData) renderPortMap(lastPortMapData);
}

function setGroupFilter(group) {
  activeGroup = activeGroup === group ? null : group;
  renderGroupPills();
  lastPortMapStructure = '';
  if (lastPortMapData) renderPortMap(lastPortMapData);
}

function renderGroupPills() {
  if (!lastPortMapData) return;
  var groups = {};
  Object.values(lastPortMapData.projects).forEach(function(p) {
    if (p.group) groups[p.group] = (groups[p.group] || 0) + 1;
  });
  var container = document.getElementById('pm-group-pills');
  container.textContent = '';
  Object.keys(groups).sort().forEach(function(g) {
    var pill = document.createElement('button');
    pill.className = 'filter-pill' + (activeGroup === g ? ' active' : '');
    pill.textContent = g + ' (' + groups[g] + ')';
    pill.addEventListener('click', function() { setGroupFilter(g); });
    container.appendChild(pill);
  });
}
```

- [ ] **Step 3: Apply filters in `renderPortMap`**

Extend the `names.forEach` block:

```javascript
names.forEach(function(name) {
  var p = projects[name];
  if (runningOnly && !p.running) return;
  if (activeGroup && p.group !== activeGroup) return;
  if (searchQuery) {
    var hay = (name + ' ' + (p.description || '') + ' ' + (p.group || '')).toLowerCase();
    if (hay.indexOf(searchQuery) === -1) return;
  }
  items.push({ ... });
});
```

Suppress rogues when any project filter is active:

```javascript
var suppressRogues = searchQuery || activeGroup;
(rogues || []).forEach(function(r) {
  if (suppressRogues) return;
  if (!showAllRogues && isLowImpactRogue(r)) { hiddenRogues++; return; }
  items.push({ ... });
});
```

Extend the structure hash:

```javascript
var parts = [
  portMapSortMode,
  showAllRogues ? 'all' : 'impact',
  runningOnly ? 'run' : 'any',
  'q:' + searchQuery,
  'g:' + (activeGroup || ''),
];
```

- [ ] **Step 4: Call `renderGroupPills()` from `renderPortMap`**

At the top of `renderPortMap`:

```javascript
function renderPortMap(data) {
  lastPortMapData = data;
  renderGroupPills();
  // ...rest of existing function
}
```

- [ ] **Step 5: Manual browser verification**

1. Reload Port Map tab
2. Group pills show with counts (`infra (2)`, `apps (3)`, etc.)
3. Clicking a pill filters to that group only + hides rogues + highlights pill
4. Typing in search narrows further by name/description
5. Clicking the active pill again clears the group filter

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: search input and group-pill filters on port map"
```

---

## Task 11: Persistent system bar above tabs

**Files:**
- Modify: `public/index.html` (new `.system-bar` element, wire up values, update sticky offsets)

- [ ] **Step 1: Add system bar markup below `<header>`**

Just after the `<header class="header">...</header>` block (around line 564), insert:

```html
<div class="system-bar">
  <div class="system-metric">
    <span class="system-metric-label">RAM</span>
    <span class="system-metric-value" id="sb-ram">—</span>
  </div>
  <div class="system-metric">
    <span class="system-metric-label">CPU</span>
    <span class="system-metric-value" id="sb-cpu">—</span>
  </div>
  <div class="system-metric">
    <span class="system-metric-label">Sessions</span>
    <span class="system-metric-value" id="sb-sessions">—</span>
  </div>
  <div class="system-metric">
    <span class="system-metric-label">Ports</span>
    <span class="system-metric-value" id="sb-ports">—</span>
  </div>
  <div class="system-metric">
    <span class="system-metric-label">Rogues</span>
    <span class="system-metric-value" id="sb-rogues">—</span>
  </div>
</div>
```

CSS:

```css
.system-bar {
  position: sticky; top: 0; z-index: 25;
  display: flex; gap: 24px; align-items: center;
  padding: 8px 24px; background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 12px;
}
.system-metric { display: flex; gap: 6px; align-items: baseline; }
.system-metric-label { color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; font-size: 10px; }
.system-metric-value { color: var(--text); font-weight: 600; font-size: 13px; }
```

- [ ] **Step 2: Update sticky offsets**

Measure `.system-bar` height in DevTools (should be ~33–36px). Update:

```css
.tab-bar { top: 36px; }
.sort-bar { top: 85px; /* system-bar + tab-bar heights */ }
```

Replace `36` / `85` with actual measured values.

- [ ] **Step 3: Wire up values from WebSocket**

Find where the WebSocket message handler processes data (search for `ws.onmessage` or similar in the script block). Add:

```javascript
function updateSystemBar(data) {
  if (data.ram) {
    var pct = data.ram.percent;
    var el = document.getElementById('sb-ram');
    el.textContent = pct + '%';
    el.style.color = pct >= 85 ? 'var(--red)' : (pct >= 70 ? 'var(--amber)' : 'var(--text)');
  }
  if (data.cpu) {
    document.getElementById('sb-cpu').textContent = data.cpu.load1 + ' (1m)';
  }
  if (data.sessions) {
    document.getElementById('sb-sessions').textContent = data.sessions.length;
  }
}
```

Call `updateSystemBar(data)` inside the message handler alongside existing UI updates.

*If the shapes don't match your actual payload, read the payload with `console.log(data)` first and map the correct paths.*

- [ ] **Step 4: Update ports/rogues counts from `renderPortMap`**

At the top of `renderPortMap`, after `lastPortMapData = data;`:

```javascript
document.getElementById('sb-ports').textContent = summary.totalPorts;
var rogueEl = document.getElementById('sb-rogues');
rogueEl.textContent = summary.rogueCount;
rogueEl.style.color = summary.rogueCount > 10 ? 'var(--red)' : (summary.rogueCount > 3 ? 'var(--amber)' : 'var(--text)');
```

(`summary` is already defined further down; move the destructuring up or reference `data.summary` directly.)

- [ ] **Step 5: Manual browser verification**

1. Reload http://localhost:4040
2. System bar pinned to top, visible on both tabs
3. Values update in real time
4. Switching tabs preserves values
5. Tab bar + sort bar still stack correctly below system bar, no overlap on scroll

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: persistent system bar above tabs with RAM/CPU/ports/rogues"
```

---

## Task 12: Last-seen indicator for stopped projects

**Files:**
- Create: `test/registry-lastseen.test.js`
- Modify: `registry.js` (in-memory `lastSeenAt` map + timestamp enrichment)
- Modify: `public/index.html` (display "stopped Xm ago" on compact cards)

- [ ] **Step 1: Write failing test**

Create `test/registry-lastseen.test.js`:

```javascript
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../registry');

describe('registry lastSeen tracking', () => {
  beforeEach(() => { registry._resetLastSeen(); });

  it('records timestamp when touched', () => {
    const before = Date.now();
    registry.touchLastSeen('alpha');
    const ts = registry.getLastSeen('alpha');
    assert.ok(ts >= before);
    assert.ok(ts <= Date.now());
  });

  it('returns null for unknown project', () => {
    assert.equal(registry.getLastSeen('nonexistent'), null);
  });

  it('updates on repeated calls', async () => {
    registry.touchLastSeen('beta');
    const first = registry.getLastSeen('beta');
    await new Promise(r => setTimeout(r, 10));
    registry.touchLastSeen('beta');
    const second = registry.getLastSeen('beta');
    assert.ok(second > first);
  });
});
```

Run: `node --test test/registry-lastseen.test.js`
Expected: FAIL with "_resetLastSeen is not a function".

- [ ] **Step 2: Implement tracking in `registry.js`**

At the top of `registry.js`:

```javascript
const lastSeenAt = new Map();
function touchLastSeen(name) { lastSeenAt.set(name, Date.now()); }
function getLastSeen(name) { return lastSeenAt.has(name) ? lastSeenAt.get(name) : null; }
function _resetLastSeen() { lastSeenAt.clear(); }
```

Add to `module.exports`:

```javascript
module.exports = {
  // ...existing exports
  touchLastSeen,
  getLastSeen,
  _resetLastSeen,
};
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `node --test test/registry-lastseen.test.js`
Expected: all pass.

- [ ] **Step 4: Enrich project status with `lastSeenMs`**

Find `getProjectStatuses` in `registry.js`. Wherever an entry's `running` field is set, add:

```javascript
if (info.running) touchLastSeen(name);
info.lastSeenMs = getLastSeen(name);
```

(Read the function first to match its existing control flow.)

- [ ] **Step 5: Display on compact stopped cards**

In `buildPortCard`'s compact branch (Task 9), between appending `nameEl` and `portNum`, add:

```javascript
if (p.lastSeenMs) {
  var ago = document.createElement('span');
  ago.className = 'last-seen';
  var mins = Math.round((Date.now() - p.lastSeenMs) / 60000);
  var label;
  if (mins < 1) label = 'just stopped';
  else if (mins < 60) label = 'stopped ' + mins + 'm ago';
  else label = 'stopped ' + Math.round(mins / 60) + 'h ago';
  ago.textContent = label;
  header.appendChild(ago);
}
```

CSS:

```css
.last-seen {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-secondary); margin-right: auto;
}
```

- [ ] **Step 6: Manual browser verification**

1. Start a registered project (e.g. any with a `command`), confirm it appears as running
2. Stop it (`kill <pid>` or use the Kill button)
3. On next poll (~3s), compact row shows `stopped <1m ago`
4. Wait 2 minutes → updates to `stopped 2m ago` on next render
5. Projects that have never been observed running show no last-seen label
6. Restart server → labels clear (in-memory only; expected)

- [ ] **Step 7: Commit**

```bash
git add test/registry-lastseen.test.js registry.js public/index.html
git commit -m "feat: show last-seen time on stopped project rows"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite**

```bash
node --test
```

Expected: all tests pass.

- [ ] **Step 2: End-to-end smoke check**

1. Reload http://localhost:4040
2. System bar shows live RAM/CPU/Sessions/Ports/Rogues above tabs
3. Sessions tab: sticky tab + sort bars, humanized uptimes
4. Port Map tab:
   - Filter bar (search + group pills) + Running-only + Show-rogues toggles all work and combine
   - Stopped projects render as compact strips with `stopped Xm ago`
   - Running cards: name is dominant, port secondary, CPU hidden at idle, memory shown once
   - Rogues hidden by default; toggle reveals all; high-impact always visible
   - Rogue cards show basename, full path on hover
   - `Kill visible rogues` works with confirm step

- [ ] **Step 3: Update README.md**

Add a `What's new` section covering:
- Humanized uptime
- Sticky nav + system bar
- Search + group filters
- Rogue hiding + bulk kill
- Compact stopped rows with last-seen

- [ ] **Step 4: Final commit**

```bash
git add README.md
git commit -m "docs: document UI monitoring improvements"
```

---

## Self-Review Notes

- Each task is independently committable and visually verifiable.
- Pure logic (formatters, bulk-kill endpoint, last-seen tracking) has unit tests.
- UI-only tasks have explicit browser-verification steps.
- No placeholders. Every code block is complete.
- Type consistency across tasks: `p.port`, `p.treeRssMB`, `p.cpuPercent`, `r.rssMB`, `p.lastSeenMs`, `p.running`.
- All filter state (`searchQuery`, `activeGroup`, `runningOnly`, `showAllRogues`, `portMapSortMode`) flows into the structure hash so existing rebuild-on-change optimization continues to work.
- `format.js` uses a plain UMD-style wrapper — browser globals + CommonJS exports, no dynamic code evaluation.
