# omp Kontingente

[![tests](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml/badge.svg)](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml)
[![license](https://img.shields.io/github/license/cabroe/omp-quota)](./LICENSE)

Bar-Widget und Popup für die [Omarchy](https://github.com/basecamp/omarchy)-Bar
mit den Provider-Kontingenten des
[omp](https://github.com/can1357/oh-my-pi)-Agenten — knappster Füllstand in
der Bar, jedes Fenster mit Status, Reset-Countdown und Plan im Popup.

## Installation

```bash
git clone https://github.com/cabroe/omp-quota.git \
  ~/.config/omarchy/plugins/cabroe.omp-quota
omarchy restart shell
```

Voraussetzungen: Omarchy, `omp` auf `PATH` (oder im `mise`-Shim),
`bun` nur für die Tests.

Unterstützte Provider: Anthropic, Z.ai, Google Antigravity, MiniMax Code,
OpenAI Codex, OpenRouter, GitHub Copilot. Die Liste wächst mit omps
eigener Provider-Registry.

## Bedienung

| Aktion              | Wirkung                                |
|---------------------|----------------------------------------|
| Linksklick          | Popup öffnen / schließen                |
| Mittelklick / `r`   | Aktualisieren                           |
| Rechtsklick / `R` / `f` | Cache verwerfen und neu abrufen     |
| `j` / `k`, ↑ / ↓    | Scrollen                               |
| Esc                 | Schließen                              |

Per IPC: `omarchy-shell cabroe.omp-quota <open|close|toggle>`.

## Einstellungen

```bash
omarchy bar set cabroe.omp-quota refreshIntervalSec 600 --json
omarchy bar set cabroe.omp-quota alarmThreshold 75 --json
omarchy bar set cabroe.omp-quota redact true --json
```

| Key                  | Default | Wirkung                                                              |
|----------------------|--------:|----------------------------------------------------------------------|
| `refreshIntervalSec` |   `300` | Abrufintervall in Sekunden (60–3600).                                |
| `alarmThreshold`     |    `90` | Ab diesem Prozentwert werden Zahl und Meter in der Warnfarbe gezeichnet. |
| `redact`             | `false` | `omp --redact`: E-Mails und Konto-IDs werden gekürzt (für Screenshots). |

Numerische Werte brauchen `--json`, sonst landen sie als Strings in
`shell.json`.

## Tests

```bash
bun test
```

## Lizenz

[MIT](./LICENSE) © 2026 cabroe
