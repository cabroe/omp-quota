# omp Kontingente

[![tests](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml/badge.svg)](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml)
[![license](https://img.shields.io/github/license/cabroe/omp-quota)](./LICENSE)

Wie viel von deinen KI-Abos ist verbraucht? Dieses Widget für die
[Omarchy](https://github.com/basecamp/omarchy)-Bar zeigt es dir: in der Bar
eine Zahl, im Popup die Details — ohne dass du bei Anthropic, OpenAI und Co.
einzeln nachsehen musst.

Die Daten kommen vom KI-Agenten [omp](https://github.com/can1357/oh-my-pi),
der die Abos verwaltet und bei den Anbietern abfragt.

## Was du siehst

**In der Bar** stehen ein Tacho-Symbol und dein knappster Wert über alle
Anbieter hinweg, etwa `57%`. Das heißt: von dem Abo, das am weitesten
aufgebraucht ist, sind 57 % weg. Ab 90 % (einstellbar) wird die Zahl in der
Warnfarbe gezeichnet, und der Mouseover verrät, um welches Abo es geht.

**Im Popup** steht jeder Anbieter mit seinen Limits:

```
Anthropic                                     Org Ada Lovelace
  Claude · 5 Hour                          4h 12m         34%
  ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  Claude · 7 Day                          20h 42m         57%
  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

MiniMax Code                                  Modell general
  General · 5 Hour                         2h 42m          8%
  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  General · 7 Day                      unbegrenzt           ∞
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

Zeile für Zeile:

| Element | Bedeutung |
|---|---|
| `Anthropic` | Der Anbieter. |
| `Org Ada Lovelace` | Um welchen Zugang es geht — je nach Anbieter der Tarif (`Plan lite`), die Organisation, das Projekt oder das freigeschaltete Modell. |
| `Claude · 5 Hour` | Das Limit und sein Zeitraum. Anbieter zählen in mehreren Zeiträumen parallel: die 5-Stunden-Grenze entscheidet, ob du *jetzt* arbeiten kannst, die 7-Tage-Grenze ist der Wochenvorrat. Kurze Zeiträume stehen oben. |
| `4h 12m` | Wann der Zähler wieder auf 0 springt. |
| `34%` | Wie viel davon verbraucht ist. |
| Balken | Derselbe Wert zum Ablesen im Vorbeigehen. |

Unter den Anbietern steht, wie alt die Zahlen sind (`Stand vor 3m`).

### Sonderfälle

| Anzeige | Heißt |
|---|---|
| `∞ unbegrenzt` | Dieses Zeitfenster hat gar kein Limit. Es steht trotzdem da, weil sonst die Frage bliebe, wo es hin ist. Grund: manche Anbieter melden ein unbegrenztes Fenster wie ein leeres, und dann sähe es wie ein unangetastetes Limit aus. |
| `erschöpft` | Aufgebraucht, hier geht bis zum Reset nichts mehr. |
| `—` | Der Anbieter macht zu diesem Limit keine Angabe. |
| `!` in der Bar | Der Abruf ist fehlgeschlagen. Die letzten Zahlen bleiben stehen, der Fehler steht im Popup darüber. |

## Installation

```bash
git clone https://github.com/cabroe/omp-quota.git \
  ~/.config/omarchy/plugins/cabroe.omp-quota
omarchy restart shell
```

Danach das Widget in der Bar aktivieren. Voraussetzungen: Omarchy und `omp`
(auf `PATH` oder als `mise`-Shim). `bun` brauchst du nur, wenn du die Tests
laufen lässt.

Welche Anbieter auftauchen, entscheidet omp: angezeigt wird, wofür du dort
angemeldet bist und wofür der Anbieter Verbrauchszahlen herausgibt — aktuell
Anthropic, Z.ai, Google Antigravity, MiniMax Code, OpenAI Codex, OpenRouter
und GitHub Copilot.

## Bedienung

| Aktion | Wirkung |
|---|---|
| Linksklick | Popup öffnen / schließen |
| Mittelklick, `r` | Neu abrufen |
| Rechtsklick, `R` oder `f` | Neu abrufen und dabei omps Zwischenspeicher verwerfen (fragt die Anbieter wirklich neu) |
| `j` / `k`, ↑ / ↓ | Im Popup scrollen |
| Esc | Popup schließen |

Von außen steuerbar:

```bash
omarchy-shell cabroe.omp-quota toggle    # open | close | toggle
```

## Einstellungen

```bash
omarchy bar set cabroe.omp-quota refreshIntervalSec 600 --json
omarchy bar set cabroe.omp-quota alarmThreshold 75 --json
omarchy bar set cabroe.omp-quota redact true --json
```

| Einstellung | Default | Wirkung |
|---|---:|---|
| `refreshIntervalSec` | `300` | Wie oft automatisch abgerufen wird, in Sekunden (60–3600). |
| `alarmThreshold` | `90` | Ab diesem Prozentwert warnt die Farbe. |
| `redact` | `false` | Kürzt E-Mails und Konto-IDs — praktisch für Screenshots. |

Das `--json` ist Pflicht, sonst landen Zahlen als Text in der Konfiguration
und werden ignoriert.

## Entwicklung

```bash
bun test              # Normalisierung, Provider-Registry, usage.sh
omarchy restart shell # Pflicht nach jeder Änderung — Speichern allein reicht nicht
```

Aufbau: `usage.sh` ruft `omp usage --json` auf, `Usage.js` formt die Antwort
in das um, was das Popup zeigt, `Panel.qml` zeichnet es. Anbieterwissen liegt
ausschließlich in `providers/`, zusammengeführt von `Providers.js`.

### Anbieter ergänzen

Neue Anbieter erscheinen von selbst, sobald omp sie kennt — der Name wird
dann aus omps ID gebildet (`mistral-code` → „Mistral Code"). Eine eigene
Datei brauchst du nur in zwei Fällen:

1. **Die Schreibweise stimmt nicht.** Aus `zai` wird sonst „Zai" statt „Z.ai".
2. **Ein Zeitfenster ist keins.** Der Anbieter meldet ein Limit, das in
   Wahrheit unbegrenzt ist (siehe `∞ unbegrenzt` oben).

Dann eine Datei `providers/<Name>.js` anlegen:

```js
.pragma library

var descriptor = {
  id: "minimax-code",          // omps Anbieter-ID aus `omp usage --json`
  name: "MiniMax Code",        // Name in der Popup-Kopfzeile
  unlimitedWindows: ["7d"]     // optional: Zeitfenster ohne echtes Limit
};
```

und sie in `Providers.js` per `.import` einbinden plus in `PLUGINS`
eintragen. Beides ist nötig; ein Test meckert, wenn eins davon fehlt.

Mehr Details brauchst du selten — wenn doch, stehen sie in
[`AGENTS.md`](./AGENTS.md). Arbeitest du mit einem Coding-Agenten, findet er
den kompletten Ablauf samt Abnahmeschritten in
`.omp/skills/omp-quota-provider/SKILL.md`.

## Lizenz

[MIT](./LICENSE) © 2026 cabroe
