---
name: omp-quota-plugin
description: "Am Omarchy-Bar-Widget-Plugin cabroe.omp-quota selbst arbeiten — Panel.qml, manifest.json, usage.sh, Usage.js, Farbrampe, Fetch-Lifecycle, Einstellungen, IPC. Auslöser: Widget zeigt nichts oder dauerhaft 'wird geladen', neue Einstellung anlegen, Bar-Label oder Popup-Layout ändern, Farben/Meter anpassen, Prozess hängt, QML-Fehler nach Änderung, 'omarchy bar set' wirkt nicht, Version/Fußzeile, scripts/analyze.js meldet etwas. NICHT für neue Provider — dafür omp-quota-provider."
---

# Am Plugin cabroe.omp-quota arbeiten

Arbeitsverzeichnis: `~/.config/omarchy/plugins/cabroe.omp-quota`.
Für **neue Provider** ist `skill://omp-quota-provider` zuständig, nicht diese Skill.

```
usage.sh ──► stdout JSON ──► Usage.js: parse() ──► Panel.qml (bindet)
   ▲                 └──► Providers.js: resolve(id) ──► providers/*.js
refresh() (poll / Popup-Öffnen / r / R / f / Rechts- / Mittelklick)
refreshHistory() (nur Popup-Öffnen) ──► Usage.js: parseHistory()  → Verbrauch
refreshStats()  (nur Popup-Öffnen) ──► Usage.js: parseStats()    → Analyse
```

## 1. Die Regel, die alles andere erklärt

**Panel.qml enthält keine pure Logik.** `bun` lädt kein QML, und die QML-Runtime
hat keine Assertions — ein Inline-Ausdruck in `Panel.qml` ist für jeden Test
unerreichbar. Berechnungen gehören nach `Usage.js` (pur, Zeit und Einstellungen
als Parameter), `Panel.qml` bindet nur.

| Gehört nach `Usage.js` | Bleibt in `Panel.qml` |
|---|---|
| Klemmen von Einstellungen (`refreshInterval`, `alarmFraction`) | Theme-/Farbproperties |
| Kurven und Schwellen (`rampFactor`) | `mix()` — braucht `Qt.rgba` |
| Text-Aufbau (`barText`, `barTooltip`, `untilText`, `agoText`) | Fetch-Lifecycle, Watchdog, IPC |
| Normalisierung des Reports (`parse`) | Layout, Bindings, Animationen |

Neue Berechnung = neue Funktion in `Usage.js` + Test in `tests/usage.test.js` +
ein Binding in `Panel.qml`. Nicht umgekehrt.

## 2. Eine Einstellung hinzufügen

Drei Stellen, alle nötig:

1. `manifest.json`: Eintrag in `barWidget.defaults` **und** in `barWidget.schema[]`
   — gleiche Keys, gleicher `defaultValue`, bei `type: "integer"` zusätzlich
   `min`/`max`/`step`. `tests/manifest.test.js` verriegelt den Gleichlauf.
2. `Usage.js`: eine Klemm-Funktion, die unbrauchbare Eingabe auf den Default
   fallen lässt — nicht auf 0. `shell.json` kann Strings enthalten (ohne
   `--json` landet jede Zahl als String), also muss `num()` durchlaufen.
3. `Panel.qml`: `readonly property … : Usage.<klemme>(settings ? settings.<key> : undefined, <default>)`

**Direkt auf `settings` zugreifen, nie über die geerbte `setting()`-Funktion.**
Deren Property-Zugriff liegt in `Ui/Panel.qml`, also registriert ein Binding
hier keine Abhängigkeit und behält nach der Injektion durch den Bar-Host seinen
Startwert.

Setzen und prüfen:

```sh
omarchy bar set cabroe.omp-quota refreshIntervalSec 600 --json   # --json, sonst String
omarchy bar set cabroe.omp-quota alarmThreshold 75 --json
omarchy bar set cabroe.omp-quota redact true --json
```

## 3. Fetch-Lifecycle — die Fallen

- **Anfrage während eines laufenden Abrufs wird gemerkt**
  (`queuedRefresh`/`queuedFresh`, `fresh` gewinnt), nie verworfen. `drainQueue()`
  spielt sie in `onRunningChanged` nach.
- **`requestRedact`** hält die Redaktionseinstellung beim Start fest.
  `applyReport()` verwirft eine Antwort, deren Einstellung nicht mehr gilt, und
  holt neu — die Redaktion passiert in omp, nicht in der Anzeige.
- **`applyReport()`/`failFetch()` steigen bei `!pending` aus**: späte
  Pipe-Fragmente nach einem Watchdog-Kill dürfen die präzise Meldung nicht
  überschreiben.
- **`fetchError` ist getrennt von `report`**: bei Fehlschlag bleiben die letzten
  Zahlen sichtbar, der Fehler steht daneben. Ein alter Stand ist brauchbar, eine
  leere Liste nicht.
- **Kein `onExited` verwenden** — Quickshell feuert es nicht, wenn das Programm
  gar nicht startet. `onRunningChanged` auswerten.
- **Watchdog (25 s) muss beides tun**: `usageProcess.running = false` UND
  `usageProcess.signal(9)`. `running = false` ist `QProcess::terminate()`
  (SIGTERM), und bash deferiert das, solange ein Vordergrund-Kind läuft. Nur
  SIGKILL trifft bash, den einzigen Halter der stdout-Pipe — erst dann feuert
  `finished` und die Queue zieht nach.
- **Der Verlaufsabruf ist ein eigener `Process` (`historyProcess`)** mit
  eigenem Watchdog, gestartet nur beim Popup-Öffnen (Verbrauchs-Ansicht).
  Fehlgeschlagene Verläufe still verwerfen — die Sparkline ist Zutat, die
  Fehlerkarte gehört dem Live-Abruf. **`statsProcess` ist die dritte Kopie
  des Musters** (Analyse-Ansicht — Session-Statistik), dieselbe stille
  Degradation.

## 4. Layout und Farben

- `pragma ComponentBehavior: Bound` bleibt die erste Zeile; Delegates deklarieren
  `required property int index`.
- **Repeater iterieren über Zähler** (`providerCount`, `limitCount`) mit
  Index-Zugriff, nie über Arrays: ein neues Array zerstört alle Delegates, und
  ein neu gebauter Meter animiert nicht (`Behavior on width` greift nur bei
  bestehenden Items).
- Geschwister über `id` adressieren, nie über `parent.children[N]`.
- **Farbrampe:** `colorFor(fraction, exhausted, base?)` mischt `base` → `urgent`
  und erreicht `urgent` genau bei `alarmAt`; die Kurve liegt in
  `Usage.rampFactor()`. Flächen starten bei `calm` (Theme-`accent`), Text bei
  `foreground`. Erschöpft ist immer `urgent` (`fraction` ist auf 1 gedeckelt).
  Unbegrenzte Fenster (`fraction < 0`) bleiben ruhig und zeigen **keinen** Track.
- Kein hartkodiertes Warngelb: die Palette liefert nur
  foreground/accent/urgent/muted. `mix()` statt `Qt.tint()` — tint komponiert
  über Alpha und ergäbe eine halbdurchsichtige statt einer Zwischenfarbe.
- Größen, Abstände, Radien über `Style.space(n)` / `Style.font.*` /
  `Style.cornerRadius`; literale Opazitäten als Property deklarieren
  (`metaOpacity`). `scripts/analyze.js` meldet Verstöße.
- Gruppenabstand gehört zum Abschnitt (`topPadding` auf `ProviderSection` und
  der Fußzeile), nicht ins `content`-spacing — das zöge Hero und Fehlerkarte mit.
- Wiederverwendbare Blöcke sind `component`s am Dateiende. Bewusst nicht in
  eigene Dateien: sie greifen direkt auf `root` zu, als eigene Datei bräuchten
  sie ein Dutzend durchgereichter Properties.

## 5. usage.sh

- `set -o pipefail`, Aufruf aus QML als `/bin/bash usage.sh` (kein Exec-Bit
  als Fehlerquelle).
- Mit dem Argument `history` ruft es `omp usage --json --history --days 7`
  auf (Verlaufssnapshots für die Sparklines, DB-Lese statt API-Rundtrip);
  `--fresh`/`invalidate` ist im Verlaufsmodus bedeutungslos und wird nicht
  ausgeführt. Mit `stats` ruft es `omp stats --json` auf (Session-Statistik
  der letzten 24 h für die Analyse-Ansicht; die Präambel "Synced …"
  schneidet die bestehende Sed-Pipeline ab). Alle Guards und die
  JSON-Garantie gelten in allen drei Modi unverändert.
- **stdout ist immer ein JSON-Objekt**, auch im Fehlerfall (`{"error": "..."}`
  mit omps stderr). Escaping über Parameter-Expansion in `json_string()`,
  **nie über sed** — die frühere sed-Pipeline ließ Zeilenumbrüche und
  Terminal-Escapes durch und erzeugte zwei kaputte Zeilen statt eines Objekts.
- **Jeder omp-Aufruf läuft durch `run_omp`** (`timeout -k 2 <limit>`). Ein
  direkter `"$OMP" …`-Aufruf ohne Hülle ist ein Befund im Analyzer.
- Exit 124 und 137 sind derselbe Fall (Frist verpasst), beide melden das
  eingelesene stderr mit. stdout ist auf 5 MB, stderr auf 2 KB gedeckelt.

## 6. Abnahme (in dieser Reihenfolge)

```sh
bun test                    # gesamte Suite
bun scripts/analyze.js      # sieben statische Regeln, exit 0 = sauber
```

QML-Runtime — die `.import`-Kette scheitert in `bun` nie, in QML schon
(Tippfehler im Pfad, ES6-Syntax). Exit 42 = ok:

```sh
cat > SmokeCheck.qml <<'EOF'
import QtQuick
import "Usage.js" as Usage
Item {
  Component.onCompleted: {
    var r = Usage.parse(JSON.stringify({ generatedAt: 1, reports: [
      { provider: "zai", limits: [ { id: "x", label: "ZAI 5 Hours Token Quota",
        window: { id: "5h", label: "5 Hours", durationMs: 18000000, resetsAt: 9 },
        amount: { usedFraction: 0.5, unit: "percent" }, status: "ok" } ] } ] }))
    Qt.exit(r.providers[0].name === "Z.ai"
      && r.providers[0].limits[0].title === "Token Quota · 5 Hours"
      && Usage.barText("G", 0.6, false, false) === "G 60%" ? 42 : 7)
  }
}
EOF
QT_QPA_PLATFORM=offscreen qml6 SmokeCheck.qml; echo "exit=$? (42=ok)"; rm -f SmokeCheck.qml
```

Laufende Shell — **Dateispeichern lädt das Widget NICHT neu**, und QML-Fehler
zeigen sich erst hier:

```sh
omarchy restart shell && sleep 4 && omarchy-shell cabroe.omp-quota open
grim /tmp/quota.png        # Layout, Meterfarben, Fußzeile prüfen
omarchy-shell cabroe.omp-quota close
```

Zusätzliche Handproben, wenn der Lifecycle berührt wurde:

1. `./usage.sh` gibt auch ohne omp im PATH ein JSON-Objekt aus.
2. `redact` umschalten: Konten kommen mit `*`-Suffix, der laufende Abruf mit
   alter Einstellung wird verworfen, nicht angezeigt.
3. `usage.sh` wegbenennen: Fehlerkarte statt dauerhaft „wird geladen".
4. omp künstlich hängen lassen: nach dem Watchdog startet `r` einen neuen
   Prozess.

## Anti-Patterns

- **Pure Logik als Inline-Ausdruck in `Panel.qml`** — unerreichbar für Tests.
- **Die geerbte `setting()`-Funktion** oder ein geratener Timer für die
  `settings`-Injektion (dafür ist `requestRedact` da).
- **Eine Refresh-Anfrage während eines Abrufs fallen lassen.**
- **`Process.onExited`** für nicht startende Prozesse.
- **Watchdog nur mit SIGTERM.**
- **JS-Array als Repeater-Model** für animierte Inhalte.
- **Providerwissen in `Usage.js`** (Namen, Strip-Tokens, Fenster-IDs) — das
  gehört in `providers/*.js`, siehe `skill://omp-quota-provider`.
- **Sortierung nach Füllstand** — die Liste sprang bei jedem Refresh.
  Provider nach `name.localeCompare(b.name, "en")`, Limits nach `durationMs`.
- **`omarchy restart shell` überspringen.**
