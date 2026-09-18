# Repository Guidelines

## Project Overview

Omarchy bar-widget plugin **cabroe.omp-quota** — shows the AI provider quotas
managed by the [omp](https://github.com/can1357/oh-my-pi) agent (Anthropic,
Z.ai, Google Antigravity, MiniMax Code, OpenAI Codex, OpenRouter, GitHub
Copilot): tightest quota as a number in the bar, every window with usage,
status, reset countdown and access in a popup. Runtime is Quickshell (Qt/QML
6) inside the Omarchy shell; tests run under Bun.

Widget UI labels are German (`unbegrenzt`, `erschöpft`, `Stand vor 3m`).
Code comments in this repo are German by convention.

## Architecture & Data Flow

```
usage.sh ──► stdout JSON ──► Usage.js: parse() ──► Panel.qml (render)
   ▲                 │
   │                 └──► Providers.js: resolve(id) ──► providers/*.js
refresh() (poll / open / r / R / right-click / middle-click)
refreshHistory() (popup open only) ──► Usage.js: parseHistory()
refreshStats() (popup open only) ──► Usage.js: parseStats()
```

1. **Trigger** (`Panel.qml`): `Component.onCompleted`, `pollTimer`
   (`refreshIntervalSec`), popup open, middle-click/`r` (refresh),
   right-click/`R`/`f` (refresh with `--fresh`), `onRedactChanged`.
   Popup open additionally runs `refreshHistory()` and `refreshStats()`
   (own `historyProcess`/`statsProcess`).
2. **Fetch**: `Process { id: usageProcess }` runs `/bin/bash usage.sh` with
   optional `--redact`/`--fresh`. `usage.sh` locates `omp` (Hyprland PATH ≠
   login PATH) and calls `omp usage --json` under `timeout -k 2 20`.
   With the `history` argument it calls `omp usage --json --history
   --days 7` instead (sparkline data; no `invalidate`, cheap DB read).
   With `stats` it calls `omp stats --json` (session statistics, last 24 h
   — omp's own default; its "Synced ..." preamble is cut by the existing
   sed pipeline).
3. **JSON guarantee**: `usage.sh` always writes one JSON object to stdout —
   on failure `{"error": "..."}` including omp's stderr. A preamble sed
   pipeline cuts everything before the first real `{`.
4. **Normalization**: `Usage.js` (`.pragma library`, pure functions) →
   `Providers.js` (registry, `resolve(id)`) → `providers/*.js` (one
   descriptor per provider that needs one). The core is provider-free.
5. **Render**: bar shows `worst` over all providers; popup lists providers
   alphabetically, limits per provider by `durationMs` ascending, each with
   title + status/amount + reset countdown + percent + animated meter.
   The popup header switches between three views (mouse or `v` key
   cycling): "Kontingente" (the limit rows), "Analyse" (stats view:
   requests/errors/tokens/cache, today's cost and per-model rows sorted by
   cost) and "Verbrauch" (the top three providers, one row each — never a
   provider twice: `Usage.topConsumers()` takes every provider's worst
   window (≥ 2 recorded points, ranked by peak, ties by average) and ranks
   the providers by that peak — each row with a large 26-bucket sparkline,
   plus `Usage.historySummary()` — average, peak, snapshot count, last
   snapshot age). Tab order: Kontingente, Verbrauch, Analyse.
   `activeView` (0/1/2) survives close; both fetches run on
   open so switching is instant.
6. **Fetch lifecycle** (`Panel.qml`): a request arriving while a fetch runs
   is queued (`queuedRefresh`/`queuedFresh`, `fresh` wins), never dropped;
   `drainQueue()` replays it on `onRunningChanged`. `requestRedact` records
   the redact setting at launch — `applyReport()` discards a response whose
   setting no longer applies and refetches. `applyReport()`/`failFetch()`
   bail out when `!pending` (late pipe fragments after a watchdog kill must
   not overwrite the precise error). A 25 s watchdog kills a hung fetch.
   `fetchError` is kept separate from `report`: on failure the last numbers
   stay visible with the error next to them. The history fetch runs the
   same pattern independently (`historyPending`, own 25 s watchdog with
   `signal(9)`) and degrades silently — a failed sparkline must never
   produce an error card; the live fetch owns the error path. The stats
   fetch (`statsPending`/`statsProcess`) is a third copy of the pattern
   with the same silent-degradation rule.

## Key Directories

| Path | Purpose |
|---|---|
| `Panel.qml` | Only entry point: `WidgetButton` (bar) + `KeyboardPanel` (popup), lifecycle, refresh queueing, watchdog |
| `Usage.js` | Pure normalization: raw JSON → render model; no provider knowledge |
| `Providers.js` | Registry: imports `providers/*.js`, `PLUGINS`/`BY_ID`, `resolve(id)`, `fallbackName(id)`, `stripTokens(id, name)` |
| `providers/` | One descriptor per provider whose name spelling or behavior deviates from derivation (5 files; `anthropic`, `google-antigravity` deliberately none) |
| `usage.sh` | PATH-robust wrapper: `omp usage --json`, `history` → `--history --days 7`, `stats` → `omp stats --json`; timeouts, JSON guarantee |
| `tests/` | `bun test` suites + `load.js` (QML-library loader for Bun) |
| `scripts/analyze.js` | Static analysis (`bun scripts/analyze.js`): rules the test suite cannot express — see below |
| `.omp/skills/` | Two project skills: `omp-quota-provider` (add a provider) and `omp-quota-plugin` (the widget itself — settings, lifecycle, colours, `usage.sh`). Both are required; the `skill` rule enforces existence, frontmatter and API references |
| `.github/workflows/tests.yml` | CI: `bun test` on push/PR to `main` |

Other plugin directories under `~/.config/omarchy/plugins/` are references,
not part of this repo.

## Development Commands

```sh
bun test                                  # whole suite
bun scripts/analyze.js                    # static analysis; exit 0 clean, 1 findings, 2 usage error
bun scripts/analyze.js --json             # machine-readable findings
omarchy restart shell                     # REQUIRED after any change — saving files alone never reloads the widget
omarchy bar set cabroe.omp-quota refreshIntervalSec 600 --json
omarchy bar set cabroe.omp-quota alarmThreshold 75 --json
omarchy bar set cabroe.omp-quota redact true --json
omarchy-shell cabroe.omp-quota toggle     # IPC smoke test: open | close | toggle
```

- Numeric settings need `--json`, or they land as strings in `shell.json`.
- No lint, no build step. QML errors only surface after
  `omarchy restart shell` — always run it before judging a QML change.
- QML-runtime smoke check without touching the running shell (exit 42 = ok):

  ```sh
  cat > SmokeCheck.qml <<'EOF'
  import QtQuick
  import "Usage.js" as Usage
  Item {
    Component.onCompleted: {
      var p = Usage.parse(JSON.stringify({ generatedAt: 1, reports: [
        { provider: "minimax-code", limits: [ { id: "x", label: "General 7 Day",
          window: { id: "7d", label: "7 Day", durationMs: 604800000, resetsAt: 9 },
          amount: { usedFraction: 0, unit: "percent" }, status: "ok" } ] } ] })).providers[0]
      Qt.exit(p.name === "MiniMax Code" && p.limits[0].statusLabel === "unbegrenzt" ? 42 : 7)
    }
  }
  EOF
  QT_QPA_PLATFORM=offscreen qml6 SmokeCheck.qml; echo "exit=$? (42=ok)"; rm -f SmokeCheck.qml
  ```

## Code Conventions & Common Patterns

### QML (`Panel.qml`)

- `pragma ComponentBehavior: Bound` first line; delegates declare
  `required property int index`.
- Read settings **directly** on `settings` — never the inherited
  `setting()` helper (its property access lives in `Ui/Panel.qml`, so a
  binding here never registers a dependency and freezes at the initial
  value). Direct access is reactive once the host injects `settings`.
- Repeaters iterate over counts (`providerCount`, `limitCount`) with index
  access (`providerAt(i)`, `limitAt(i)`), never over arrays: a new array
  destroys all delegates and a rebuilt meter does not animate (`Behavior on
  width` only fires on existing items).
- Sibling elements are addressed by `id`, never `parent.children[N]`.
- Reused layout terms get one name (`titleRow.tailWidth`) — title width and
  spacer must subtract the identical value.
- Group spacing belongs to the block, not to the surrounding `content`
  spacing: `ProviderSection` and the footer carry their own `topPadding`,
  and `ProviderSection` additionally a `bottomPadding`. Raising
  `content.spacing` instead would pull hero, error card and footer apart by
  the same amount, and a larger `topPadding` alone would leave the last
  provider glued to the footer while every other block has air.
- Reusable blocks are `component`s at file end (`ProviderSection`,
  `LimitRow`).
- Every bar is tinted, not just the tight ones: `colorFor(fraction,
  exhausted, base?)` interpolates `base` → `urgent` and reaches `urgent`
  exactly at `alarmAt`. `exhausted` is always `urgent` regardless of fill
  (the fraction is capped at 1, so an overdrawn quota would otherwise look
  merely full); unlimited rows (`fraction < 0`) stay at `base`. The
  exponent 2.2 pushes the colour to the back half — linear made a 45 %
  window half red and the scale worthless. Three hard steps were the
  predecessor; they left everything below the warn threshold looking
  identical, which is most rows.
- `base` differs by surface: meters start at `calm` (theme `accent`, so the
  filled area separates from the labels), text starts at `foreground` (a
  grey-tinted 3 % number is just harder to read). Both reach `urgent` in the
  same instant, so area and number never disagree. No hard-coded amber — the
  palette ships only foreground/accent/urgent/muted, and a theme like the
  monochrome-red default has no warning hue to borrow.
- Mix colours with the local `mix(from, to, t)`, never `Qt.tint()`: tint
  composites over alpha, so a factor below 1 yields a translucent colour
  instead of an intermediate one.
- A limit row derives `tone` (meter) and `textTone` (percent) from that one
  function. The meter carries `Behavior on color` alongside `Behavior on
  width`, otherwise a growing bar switches colour in one frame and reads as
  a rebuild.
- Pure logic does not live in `Panel.qml`. `bun` cannot load QML and the QML
  runtime has no assertions, so an inline expression there is unreachable
  for every test. `Usage.js` therefore owns the settings clamps
  (`refreshInterval`, `alarmFraction`), the ramp curve (`rampFactor`), and
  the bar strings (`barText`, `barTooltip`); `Panel.qml` only binds. What
  stays in QML is what needs QML: `mix()` (needs `Qt.rgba`), colour/theme
  properties, and the fetch lifecycle.
- Theme switches take effect live, without `omarchy restart shell`: `Color`'s
  foundational palette is reassigned from the shell IPC payload, and every
  colour here is a binding on `Color.*` or on the mirrored `bar.*`. Verified
  by switching Catppuccin → Gruvbox with the popup open; meters re-based
  from blue and teal respectively. Colours must therefore stay bindings —
  never snapshot a `Color.*` value into a plain `var` at startup.
- The plugin bar API (`Ui/PluginBarApi.qml`) exposes `foreground`,
  `barForeground`, `background`, `urgent`, `fontFamily`, `position`,
  `vertical`, `barSize` — and **no** `accent`. `calm` therefore reads
  `Color.accent` directly; a `bar.accent` fallback branch is dead code.
- Typographic hierarchy in the popup, largest first: hero `display`,
  provider name `body` + bold + full `foreground`, limit title `bodySmall`,
  captions (detail, reset, meta, footer) `caption` + `dim`. The provider
  name overrides `PanelSectionHeader`'s built-in `Qt.darker(…, 1.4)` and its
  `caption` default on purpose — with them it was the smallest, faintest
  text in its own section, below the rows it introduces.
- Literal opacities are declared as properties (`metaOpacity`), not inlined;
  the `panel-hardcoding` rule flags bare values above 0.5.
- Reactive clock: `nowMs` property + 30 s timer running only while
  `opened || hasError` (the tooltip reads the aging of the last fetch).
  Do not solve this via a hover signal — that depends on Qt-internal signal
  ordering.
- Hung process: the watchdog must set `usageProcess.running = false` AND
  `usageProcess.signal(9)`. `running = false` maps to `QProcess::terminate()`
  (SIGTERM), which bash defers while a foreground child runs; SIGKILL hits
  bash, the sole holder of the stdout pipe, so `finished` is guaranteed and
  the queue drains. `signal()` guards dead processes itself.

### JavaScript (`Usage.js`, `Providers.js`, `providers/*.js`)

- `.pragma library` first line, then `.import` lines. **No ES6**: only `var`
  and `function` — the test loader collects exports via regex on exactly
  these two top-level forms.
- `Usage.js` is pure: no QML dependency, no `Date.now()` inside (time comes
  in as a parameter — testability).
- `num(value)` guards `null`/`""`/booleans to NaN — otherwise a JSON `null`
  renders as 0 % or a reset "now" instead of "no data".
- Quota truth ordering in `usedFraction()`: `usedFraction` →
  `remainingFraction` (as `1 - r`) → `used/limit`.
- `accessLabel()` fills the header slot with exactly one `"Noun Value"`
  entry: `planType` ("Plan lite") → `orgName` ("Org …", only without a plan)
  → `projectId` ("Projekt …") → `models` minus `unavailableModels`. The noun
  is mandatory; `orgName` alone once posed as a plan ("Anthropic · Max
  Mustermann").
- Phantom windows: omp derives windows from fields that describe no quota at
  all (MiniMax keeps `current_weekly_remaining_percent` at 100 for an
  unlimited week; omp computes `(100-100)/100` = a permanent 0 % window —
  20/20 history snapshots at 0.0 % while the 5 h window hit 35 %). Such
  windows live in the provider plugin's `unlimitedWindows` and normalize to
  `fraction: -1` (meter hidden, loses every `worst` comparison),
  `percentText: "∞"`, `statusLabel: "unbegrenzt"`, `resetsAt: NaN` (the end
  of a week without a limit is not a reset). Never delete the row — "window
  missing" raises the question "unbegrenzt" answers. `isUnlimited()` fires
  only at exactly 0 %: real usage turns the row back into a quota.
- Sorting is never by fill level (the list would jump every refresh):
  providers by `name.localeCompare(b.name, "en")`, limits by `durationMs`
  ascending. The explicit locale is part of the contract.
- Labels: regex-escape every stripped token (`Z.ai`), drop a lone
  `quota|limit|usage`. User-facing numbers via `compact()` (German decimal
  comma) and `plural(count, one, many)`.

### Provider registry (`Providers.js`, `providers/`)

- A plugin carries only what omp's report does not provide: display-name
  spelling and phantom windows. `strip` is derived — `stripTokens(id, name)`
  splits the ID on `[-_.]` plus the name on whitespace, dedupes
  case-insensitively (omp's real labels almost never name the provider:
  "Claude 5 Hour", "General 7 Day", "30 days"; hand-maintained lists were
  dead in 6 of 7 entries).
- `resolve(id)` ALWAYS returns a complete descriptor (`id`, `name`, `strip`,
  `unlimitedWindows`); unknown IDs get `fallbackName()` titlecasing
  (`some-new-provider` → "Some New Provider", empty → "Unbekannt") — the
  fallback name never enters `strip`. The core never null-checks fields.
- Adding a provider = create `providers/<Name>.js` + one `.import` and one
  `PLUGINS` entry in `Providers.js` (imports alphabetical by filename). Both
  are required; the registry consistency test catches a missing half.
- Full procedure with acceptance steps: `.omp/skills/omp-quota-provider/SKILL.md`.

### Shell (`usage.sh`)

- `set -o pipefail`; invoked as `/bin/bash usage.sh` from QML (no exec-bit
  dependency).
- Always JSON on stdout, even on error; escape via bash parameter expansion
  in `json_string()`, never `sed` (newlines/ANSI escapes break the object).
- Preamble sed requires `{"`, `}` or EOL right after the `{`, so text
  banners like `{warn} ...` don't pass as payload.
- `OMP_TIMEOUT=20` (`timeout -k 2 20`), `--fresh` invalidate gets its own
  3 s budget; exit 124 and 137 both report as timeout with captured stderr.
  stdout capped at 5 MB, stderr at 2 KB.
- PATH search order: `command -v omp`, mise shims, `~/.local/bin`,
  `~/.bun/bin`, `/usr/local/bin`, `/usr/bin`, last `mise which omp`.

### Never (each of these was a real bug)

- Never use the inherited `setting()` helper, never guess a timer for
  `settings` injection (reconcile via `requestRedact` instead).
- Never drop a refresh request during a running fetch — queue it.
- Never rely on `Process.onExited` for non-starting processes — evaluate
  `onRunningChanged` + watchdog.
- Never leave a hung process at SIGTERM only — the watchdog must also
  `signal(9)`.
- Never use a JS array as Repeater model for animated content.
- Never move provider knowledge (names, strip tokens, window IDs) back into
  `Usage.js`, never hand-maintain a strip list, never add a plugin that only
  repeats the derivable name.
- Never let `resolve()` return partial objects.
- Never escape JSON with `sed`, never call `omp` without a timeout or
  directly from QML.
- Never sort by fill level.

## Important Files

| File | Role |
|---|---|
| `Panel.qml` | Entry point: UI, lifecycle, IPC, refresh logic, error handling |
| `Usage.js` | JSON → render model (provider-free) |
| `Providers.js` | Registry: `PLUGINS`, `BY_ID`, `resolve(id)`, `fallbackName(id)`, `stripTokens(id, name)` |
| `providers/*.js` | One `descriptor` per deviating provider (`id`, `name`, optional `unlimitedWindows`) |
| `usage.sh` | omp invocation, PATH resolution, timeout, JSON guarantee |
| `manifest.json` | Plugin identity + settings schema; `defaults` and `schema[]` MUST stay in sync (same keys, same `defaultValue`, `min`/`max`/`step` where relevant). Also the single source for the version shown bottom-right in the popup — `Panel.qml` reads it through a `FileView`, never as a QML literal |
| `tests/load.js` | Loads QML `.pragma library` files for Bun |
| `.omp/skills/omp-quota-provider/SKILL.md` | Provider-addition procedure incl. acceptance |

## Runtime/Tooling Preferences

- **Runtime:** Quickshell (Qt/QML 6.x) inside the Omarchy shell.
- **Shell:** bash for `usage.sh` (`set -o pipefail`; no POSIX-only constraint).
- **Tests:** `bun test` (`bun:test`), Bun version pinned via `.bun-version`.
- **No package manager, no dependencies:** no `package.json`/node_modules —
  only `omp` (on PATH or installed), coreutils (`timeout`, `mktemp`) and
  mise/bun. QML JS libraries are ES5 (`var`/`function` only).
- `settings` is injected by the bar host — not present before the first
  fetch (see `requestRedact`).
- Project-local omp skill: `.omp/skills/omp-quota-provider/` (discovered as
  `skill://omp-quota-provider`).

## Testing & QA

- `bun test` from the repo root; CI (`.github/workflows/tests.yml`) runs it
  on push/PR to `main` (ubuntu-latest, Bun from `.bun-version`, 5 min
  timeout, per-ref concurrency cancel).
- `tests/load.js`: `new Function` cannot parse the QML JS dialect, so the
  loader strips `.pragma library` and resolves every `.import`
  **recursively, relative to the importing file** (that was a real bug:
  resolving against `tests/` first), collecting exports via
  `/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm`.
- `tests/usage.test.js` pins the parse contract against real omp report
  shapes; regression tests name their bugs (JSON primitives crashing
  `parse`, `num(null)` becoming 0, missing `account` crashing
  `collapseAccounts`).
- `tests/providers.test.js`: `KNOWN` (with plugin) vs `DERIVED` (name falls
  out of the ID); phantom-window exclusivity is deliberately narrow —
  only `minimax-code` may carry `["7d"]`, a second entry is a behavior
  change that must be conscious; registry consistency checks
  `providers/*.js` ↔ `PLUGINS` in both directions, unique IDs, and that
  plugins do NOT declare `strip`.
- `tests/usage-sh.test.js`: fake-omp harness in a temp PATH with symlinked
  coreutils (`sed`, `mktemp`, `rm`, `timeout`, …), a `mise` stub and an
  absolute `/bin/bash` call. Isolation is mandatory: with `/usr/bin` in
  PATH, `mise which omp` finds the real omp and the test hits a live
  provider API.
- `tests/manifest.test.js`: manifest invariants, especially
  `defaults` ↔ `schema` lockstep.
- `scripts/analyze.js` covers what a unit test cannot see, seven rules:
  `provider-registry` (`providers/*.js` ↔ `.import` ↔ `PLUGINS`, both
  directions, alphabetical import order as warn), `plugin-discipline`
  (`id`/`name` present, `strip` forbidden), `panel-hardcoding`
  (`font.pixelSize`/`radius`/`opacity`/inline `color` bypassing `Style.*`),
  `usage-sh` (`set -o pipefail`, every omp call through `run_omp`/`timeout`,
  no `sed` escape in `json_string`), `manifest-bindings` (every
  `schema[].key` referenced in `Panel.qml`), `provider-coverage` (a plugin
  whose `name` equals `fallbackName(id)` and carries no `unlimitedWindows`
  is dead configuration — the derivation is loaded from the real
  `Providers.js` via `tests/load.js`, never reimplemented), and `skill`
  (every skill directory under `.omp/skills/` is checked, not a fixed path —
  both `REQUIRED_SKILLS` exist, frontmatter `name`/`description` match the
  directory, and every `` `fn(` `` a skill names is declared in
  `Providers.js`, `Usage.js`, `Panel.qml` or `usage.sh`. Names in
  `FORBIDDEN` — currently `setting` — are checked in reverse: a skill may
  name them as an anti-pattern, and a real declaration is the finding).
- `tests/analyze.test.js` drives the analyzer as a subprocess over temp-dir
  fixtures (`--root=`, `--json`); each rule has a violating fixture, and
  `provider-coverage` additionally pins both justifications (deviating
  spelling, phantom window) as NOT findings.
- Smoke tests for maintainers:
  1. `./usage.sh` always prints valid JSON (missing omp → error object).
  2. `./usage.sh | head -c1` is non-empty and not a warning banner.
  3. `bun test` green.
  4. Toggling `redact` refetches redacted accounts (prefix ends in `*`);
     an in-flight fetch with the old setting is discarded, not shown.
  5. Missing `usage.sh` must not leave the widget on "loading" forever —
     `failFetch()` shows the error card.
  6. A hung `omp` must not wedge the widget: after the watchdog, `r`
     starts a new process.
- No test replaces the visual check after `omarchy restart shell` (bar
  layout, popup scrolling, meter animation, alarm color above
  `alarmThreshold`).
