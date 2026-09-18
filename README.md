# omp Kontingente

[![tests](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml/badge.svg)](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml)
[![license](https://img.shields.io/github/license/cabroe/omp-quota)](./LICENSE)

Bar-Widget und Popup für die [Omarchy](https://github.com/basecamp/omarchy)-Bar
mit den Provider-Kontingenten des
[omp](https://github.com/can1357/oh-my-pi)-Agenten — knappster Füllstand in
der Bar, jedes Fenster mit Status, Reset-Countdown und Zugang im Popup.

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

Fenster ohne Kontingent stehen als `∞ unbegrenzt` da, ohne Meter: MiniMax'
Token-Plan hat nur ein 5-Stunden-Limit, omp leitet daraus trotzdem ein
7-Tage-Fenster mit dauerhaft 0 % ab. Sobald dort echter Verbrauch gemeldet
wird, zählt die Zeile wieder als Kontingent.

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

## Provider hinzufügen

omps Report nennt nur die Provider-ID (`minimax-code`), keinen Anzeigenamen.
Alles, was daraus **nicht** ableitbar ist, liegt als eigene Plugin-Datei in
`providers/` — nicht in `Usage.js`. Zwei Schritte:

1. **`providers/<Name>.js` anlegen** — eine QML-JS-Library mit genau einem
   Top-Level-Export `descriptor`:

   ```js
   .pragma library

   var descriptor = {
     id: "minimax-code",
     name: "MiniMax Code",
     unlimitedWindows: ["7d"]
   };
   ```

   | Feld | Pflicht | Bedeutung |
   |---|---|---|
   | `id` | ja | omps Provider-ID aus `omp usage --json` (`report.provider`). |
   | `name` | ja | Anzeigename in der Popup-Kopfzeile. Nötig nur, wo das Titelcasing der ID danebenliegt: `zai` → „Zai" statt „Z.ai", `minimax-code` → „Minimax Code". Für `anthropic` oder `google-antigravity` fällt der Name aus der ID, die brauchen deshalb kein Plugin. |
   | `unlimitedWindows` | nein | Fenster-IDs (`window.id`, ersatzweise `scope.windowId`), die omp aus Anbieterfeldern ableitet, die gar kein Kontingent beschreiben. Im JSON sind sie von einem echten, frisch zurückgesetzten Fenster nicht unterscheidbar — deshalb lokales Wissen. |

   Strip-Tokens für redundante Labels stehen **nicht** im Plugin: sie werden
   aus ID und Anzeigenamen abgeleitet (`minimax-code` + „MiniMax Code" →
   `minimax`, `code`; der Strip matcht case-insensitiv).

2. **In `Providers.js` eintragen** — die Datei per `.import` einbinden und
   das `descriptor`-Objekt in `PLUGINS` aufnehmen (Reihenfolge alphabetisch
   nach Dateiname). `resolve(id)` vervollständigt jeden Descriptor, also
   prüft der Kern nie auf fehlende Felder.

Ein Registry-Konsistenztest fängt den Fall „Datei angelegt, Import
vergessen" — ohne ihn bliebe der neue Provider stumm.

Arbeitest du mit einem Coding-Agenten in diesem Repo, steht derselbe Ablauf
inklusive Abnahmeschritten als Projekt-Skill bereit:
`.omp/skills/omp-quota-provider/SKILL.md` (in omp lesbar als
`skill://omp-quota-provider`).

## Tests

```bash
bun test
```

## Lizenz

[MIT](./LICENSE) © 2026 cabroe
