# omp Quotas

[![tests](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml/badge.svg)](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml)
[![license](https://img.shields.io/github/license/cabroe/omp-quota)](./LICENSE)

How much of your AI subscriptions have you burned through? This widget for
the [Omarchy](https://github.com/basecamp/omarchy) bar tells you: one number
in the bar, the details in a popup — no more checking Anthropic, OpenAI and
the rest one by one.

The data comes from the AI agent
[omp](https://github.com/can1357/oh-my-pi), which manages those
subscriptions and queries the providers.

> The widget's own labels are German (`unbegrenzt`, `erschöpft`, `Stand vor
> 3m`). The examples below show them as they appear on screen.

## What you see

**In the bar**: a gauge icon plus your tightest value across all providers,
e.g. `57%`. That means the subscription closest to its limit is 57 % used.
From 0 % on, number and bar tint continuously toward the warning colour,
reaching it exactly at the threshold (90 % by default), and the tooltip
tells you which subscription it is.

**In the popup**: every provider with its limits. The header switches
between three views — **Kontingente** (quotas), **Verbrauch** (history)
and **Analyse** (session statistics) — with the mouse or the `v` key,
which cycles through them.

```
Anthropic                                     Org Ada Lovelace
  Claude · 5 Hour                          4h 12m         34%
  ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

MiniMax Code                                  Modell general
  General · 5 Hour                         2h 42m          8%
  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  General · 7 Day                      unbegrenzt           ∞
```

Line by line:

| Element | Meaning |
|---|---|
| `Anthropic` | The provider. |
| `Org Ada Lovelace` | Which access this is — depending on the provider: the plan (`Plan lite`), the organisation, the cloud project, or the enabled model. |
| `Claude · 5 Hour` | The limit and its time span. Providers count in several spans at once: the 5-hour budget decides whether you can work *right now*, the 7-day one is your weekly supply. Short spans come first. |
| `4h 12m` | When the counter resets to zero. |
| `34%` | How much of it is used. |
| Bar | The same value, readable at a glance. |

Below the providers you see how old the numbers are (`Stand vor 3m` — as of
3 minutes ago).

The **Verbrauch** view turns those hourly snapshots into the headline: the
three most used providers, one row each (never a provider twice) with its
worst window. Each row shows the last 7 days condensed into 26 bars — each
bar is the peak of its hour, coloured like the meter — plus the average,
the peak, and how many hourly snapshots back it. A row at 73 % that peaked
at 92 % two days ago reads very differently from one that has been
climbing all evening.

The **Analyse** view shows omp's session statistics for the last 24 h:
requests and errors, total tokens, cache hit rate, today's cost, and one
row per model sorted by cost — subscription models that cost nothing show
their request count instead.

### Special cases

| Display | Means |
|---|---|
| `∞ unbegrenzt` | This time span has no limit at all. It is still listed, because its absence would raise the very question the label answers. Reason: some providers report an unlimited window exactly like an empty one, which would look like an untouched quota. |
| `erschöpft` | Exhausted — nothing works here until the reset. |
| `—` | The provider reports no figure for this limit. |
| `!` in the bar | The fetch failed. The last known numbers stay on screen, with the error shown above them in the popup. |

## Installation

```bash
git clone https://github.com/cabroe/omp-quota.git \
  ~/.config/omarchy/plugins/cabroe.omp-quota
omarchy restart shell
```

Then enable the widget in your bar. Requirements: Omarchy and `omp` (on
`PATH` or as a `mise` shim). `bun` is only needed to run the tests.

Which providers show up is omp's call: you see what you are signed in to and
what the provider actually exposes usage figures for — currently Anthropic,
Z.ai, Google Antigravity, MiniMax Code, OpenAI Codex, OpenRouter and GitHub
Copilot.

## Usage

| Action | Effect |
|---|---|
| Left click | Open / close the popup |
| Middle click, `r` | Fetch again |
| Right click, `R` or `f` | Fetch again and drop omp's cache (really re-queries the providers) |
| `v` | Switch views: Kontingente → Verbrauch → Analyse (also by clicking the tabs) |
| `j` / `k`, ↑ / ↓ | Scroll inside the popup |
| Esc | Close the popup |

From the outside:

```bash
omarchy-shell cabroe.omp-quota toggle    # open | close | toggle
```

## Settings

```bash
omarchy bar set cabroe.omp-quota refreshIntervalSec 600 --json
omarchy bar set cabroe.omp-quota alarmThreshold 75 --json
omarchy bar set cabroe.omp-quota redact true --json
```

| Setting | Default | Effect |
|---|---:|---|
| `refreshIntervalSec` | `300` | How often to fetch automatically, in seconds (60–3600). |
| `alarmThreshold` | `90` | Percentage at which the colour starts warning. |
| `redact` | `false` | Shortens e-mails and account IDs — handy for screenshots. |

The `--json` flag is mandatory; without it numbers land in the config as
strings and get ignored.

## Development

```bash
bun test                  # normalisation, provider registry, usage.sh, manifest, analyzer
bun scripts/analyze.js    # static rules beyond the tests; exit 0 = clean
omarchy restart shell     # required after every change — saving a file is not enough
```

How it fits together: `usage.sh` calls `omp usage --json` (plus
`--history --days 7` and `omp stats --json` for the Verbrauch and Analyse
views), `Usage.js` turns the responses into what the popup renders,
`Panel.qml` draws it. Everything provider-specific lives in `providers/`
alone, merged by `Providers.js`.

### Adding a provider

New providers appear on their own as soon as omp knows them — the display
name is then derived from omp's ID (`mistral-code` → "Mistral Code"). You
only need a file of your own in two cases:

1. **The spelling is wrong.** `zai` would otherwise render as "Zai" instead
   of "Z.ai".
2. **A time span isn't one.** The provider reports a limit that is in fact
   unlimited (see `∞ unbegrenzt` above).

Then add `providers/<Name>.js`:

```js
.pragma library

var descriptor = {
  id: "minimax-code",          // omp's provider ID from `omp usage --json`
  name: "MiniMax Code",        // name in the popup header
  unlimitedWindows: ["7d"]     // optional: time spans without a real limit
};
```

and register it in `Providers.js`: pull it in with `.import` and add it to
`PLUGINS`. Both are required; a test complains if either is missing.

You rarely need more than that — if you do, it is all in
[`AGENTS.md`](./AGENTS.md) (German). Working with a coding agent? It will
find the full procedure, verification steps included, in
`.omp/skills/omp-quota-provider/SKILL.md`.

## License

[MIT](./LICENSE) © 2026 cabroe
