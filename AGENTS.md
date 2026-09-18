# Repository Guidelines

Omarchy-Bar-Plugin **cabroe.omp-quota** — zeigt Kontingente des `omp`-Agenten
([oh-my-pi](https://github.com/can1357/oh-my-pi)) für Anthropic, Z.ai, Google
Antigravity, MiniMax Code, OpenAI Codex, OpenRouter und GitHub Copilot in
einem Bar-Widget samt Popup.

## Project Overview

- **Zweck:** `omp usage --json` ausführen, das Ergebnis auf eine
  einheitliche Form bringen, in der Bar das knappste Fenster (Prozent) und
  im Popup jedes Fenster mit Füllstand, Status, Reset-Countdown und Plan
  zeigen.
- **Plugin-Form:** Omarchy-Bar-Widget (`kinds: ["bar-widget"]`,
  `entryPoints.barWidget: "Panel.qml"`). Identifikation als
  `moduleName` / `ipcTarget: "cabroe.omp-quota"`.
- **Aktivierung:** `on-demand`. Wird in der Bar angezeigt, sobald es
  aktiviert ist.
- **IPC-Befehle:** `omarchy-shell cabroe.omp-quota open|close|toggle`.

## Architecture & Data Flow

```
usage.sh  ──► stdout JSON  ──►  Usage.js: parse()  ──►  Panel.qml (report)
   ▲                                                              │
   │                                                              ▼
refresh() (poll / open / r / R / right-click / middle-click)   render
```

1. **Trigger:** `Component.onCompleted`, `pollTimer`
   (`refreshIntervalSec`), `onOpenedChanged`, Mittelklick / `r` (refresh),
   Rechtsklick / `R` / `f` (refresh mit `--fresh`), `onRedactChanged`.
2. **Prozess:** `Process { id: usageProcess }` ruft `/bin/bash usage.sh` mit
   optional `--redact` und/oder `--fresh` auf. `usage.sh` lokalisiert `omp`
   (Hyprland-PATH ist nicht Login-PATH) und führt `omp usage --json` unter
   `timeout 20` aus. Bei `--fresh` wird vorher `omp usage invalidate`
   aufgerufen.
3. **JSON-Pfad:** `usage.sh` garantiert, dass stdout immer ein JSON-Objekt
   ist (im Fehlerfall `{"error": "..."}`, inklusive omps stderr). Eine
   Vorspann-Sed-Pipeline schneidet auf das erste `{` zu; ergibt das nichts,
   ist es ebenfalls ein Fehlerobjekt.
4. **Normalisierung:** `Usage.js` (`pragma library`, reine Funktionen,
   ohne QML-Abhängigkeit) glättet vier Eigenheiten des Rohreports:
   uneinheitliche Mengenangaben → `usedFraction` als Wahrheit;
   `scope.sharedGroup` (Google Antigravity) wird per `dedupe()` auf eine
   Zeile reduziert (höchster Füllstand gewinnt); Labels werden von
   redundanten Provider-/Fenstertokens befreit; ein providerübergreifend
   gleiches Konto wandert per `collapseAccounts()` nach `sharedAccount`.
5. **Render:** `Panel.qml` zeigt `worst` (knappster Wert über alle
   Provider) als Zahl in der Bar; im Popup je Provider eine Liste nach
   `durationMs` (kurz zuerst), je Limit Titel + Status/Absolutwert +
   Reset-Countdown + Prozent + Meter-Animation.
6. **Fehlerstrategie:** `fetchError` ist getrennt vom `report`; bei Fehler
   bleiben die letzten Zahlen sichtbar, der Fehler steht daneben.
   `failFetch()` läuft sowohl bei `onRunningChanged` (Skript fehlt) als auch
   nach 25 s Watchdog (Hänger) — und der Watchdog **killt** den Prozess.

## Key Directories

|Pfad|Zweck|
|---|---|
|`manifest.json`|Plugin-Metadaten + Settings-Schema (Single Source of Truth für UI-Optionen)|
|`Panel.qml`|Einziger Entry Point: `WidgetButton` (Bar) + `KeyboardPanel` (Popup)|
|`Usage.js`|Reine Normalisierungsfunktionen, `.pragma library`|
|`usage.sh`|PATH-robuster Wrapper um `omp usage --json`, mit Zeitlimit|
|`tests/`|`bun test`-Suiten: `usage.test.js`, `usage-sh.test.js`, `manifest.test.js`|
|`README.md`|Doku, Bedienung, IPC, Settings, Dev-Notizen|
|`.gitignore`|Editor-Schrott (`*.swp`, `*~`, `.DS_Store`)|

Andere Plugin-Verzeichnisse unter `~/.config/omarchy/plugins/` (z. B.
`custom.wireguard`, `nixfred.trackpad-pulse`) sind Referenzen, nicht Teil
dieses Repos.

## Development Commands

**Hot reload:** Datei speichern reicht NICHT für die laufende Instanz —
nötig ist immer:

```sh
omarchy restart shell
```

**Settings setzen** (mit `--json`, sonst landen Zahlen als Strings):

```sh
omarchy bar set cabroe.omp-quota refreshIntervalSec 600 --json
omarchy bar set cabroe.omp-quota alarmThreshold 75 --json
omarchy bar set cabroe.omp-quota redact true --json
```

**IPC smoke test:**

```sh
omarchy-shell cabroe.omp-quota toggle
```

**Tests:**

```sh
bun test
```

**Format:** Es gibt keinen Lint- oder Build-Schritt im Repo. Andere
Plugins verwenden `lint-qml.py`/`Makefile` — für dieses Plugin nicht
nötig, QML-Fehler zeigen sich erst im `omarchy restart shell`.

## Code Conventions & Common Patterns

### QML (`Panel.qml`)

- `pragma ComponentBehavior: Bound` (erste Zeile) — Property-Zugriffe
  benötigen `id`-Referenz, Repeater-Delegates deklarieren
  `required property int index`.
- IDs nur für Komponenten, die mehrfach gebraucht werden
  (`usageProcess`, `watchdog`, `pollTimer`, `panel`, `flick`, `button`).
- `implicitWidth/Height` aus der Bar-Komponente (`button`) propagieren.
- `settings` direkt lesen — NICHT `setting()` aus `Ui/Panel.qml`. Die
  geerbte Variante registriert keine Binding-Abhängigkeit, der Wert
  bliebe auf seinem Startwert stehen. Direktzugriff macht Bindings reaktiv.
- Erster Abruf in `Component.onCompleted`. Die spätere `settings`-Injektion
  wird nicht abgewartet, sondern korrigiert: `refresh()` merkt sich in
  `requestRedact`, mit welcher Redaktionseinstellung der Aufruf startete,
  und `applyReport()` verwirft einen Report, dessen Einstellung nicht mehr
  gilt.
- `refresh()` verwirft nie eine Anfrage. Läuft ein Abruf, landet sie in
  `queuedRefresh`/`queuedFresh` (`fresh` gewinnt) und wird in
  `onRunningChanged` per `drainQueue()` nachgezogen.
- `applyReport()` steigt bei `!pending` aus: nach einem Watchdog-Kill fällt
  noch ein stdout-Fragment aus der Pipe, das die präzise Fehlermeldung nicht
  überschreiben darf.
- Repeater iterieren über Zähler (`providerCount`, `limitCount`) und lesen
  Daten per Index (`providerAt()`, `limitAt()`), NICHT über das Array aus
  `report`. Ein neues Array zerstört alle Delegates, und ein neu gebautes
  Meter animiert nicht.
- Reactive Clocks: `nowMs: Date.now()` als Property und ein 30-s-Timer, der
  nur bei `root.opened || root.hasError` tickt. Der Fehlerfall gehört dazu,
  weil `WidgetButton` `tooltipText` nur bei `onEntered` liest und der
  Tooltip dort die Alterung des Abrufs nennt. NICHT über ein Signal auf
  `tooltipHovered` lösen — das hinge an einer Qt-internen Signalreihenfolge.
- Eigenständige `component LimitRow: Column { … }` am Dateiende für die
  Zeile (Titel + Status/Absolutwert + Reset + Prozent + Meter).
- Lange Properties: `borderSpec`, `anchors.baseline` für Detail/Reset/
  Prozent auf Titel-Baseline.
- `Behavior on width { NumberAnimation { duration: 160; easing.type:
  Easing.OutCubic } }` für die Meter-Füllung — funktioniert nur mit dem
  Count-Modell oben.

### JavaScript (`Usage.js`)

- `.pragma library` als erste Zeile (eigenständige Library, kein QML).
- Reine Funktionen, keine Closures, keine `Date.now()` direkt (Wert kommt
  rein — Testbarkeit).
- Provider-Strip-Liste in `PROVIDERS`; unbekannte Provider via
  `id.split(/[-_.]/)` zu "Some New Provider".
- Regex-Escaping Pflicht beim Token-Strip (`token.replace(/[.*+?^${}()|
  [\]\\]/g, "\\$&")`).
- `num(value)` als zentraler `Number()`-Wrapper, `clamp(value, lo, hi)`
  für 0..1-Bounds.
- Sortierreihenfolge NIE nach Füllstand (Liste würde bei jedem Refresh
  springen). Provider alphabetisch (`a.name.localeCompare(b.name)`),
  Limits nach `durationMs` aufsteigend.
- `planLabel()` liefert ausschließlich `planType`. Kein `orgName`-Fallback:
  Anthropic liefert kein `planType`, damit stand dort der Name der Person
  als „Plan".
- `STATUS_LABELS` spiegelt omps Vokabular (`ok`, `warning`, `exhausted`,
  `unknown`); unbekannte Werte werden unverändert durchgereicht.
- `amountText()` liefert den Absolutwert nur bei `unit !== "percent"` —
  sonst wiederholt er den Prozentwert. `compact()` formatiert mit deutschem
  Dezimalkomma (850 / 1,2k / 12k / 4,1M).
- `plural(count, one, many)` für jede Zählangabe; ein hart singulares Label
  ist bei zwei Einträgen falsch.
- `failed(message)` erzeugt die vollständige Report-Feldform, damit das
  Panel nie gegen fehlende Felder prüfen muss.

### Shell (`usage.sh`)

- `set -o pipefail`.
- Immer JSON auf stdout — auch im Fehlerfall
  (`emit_error "{...}"`, exit 1). Auch dann, wenn die Ausgabe keine
  geschweifte Klammer enthält und die Sed-Pipeline leer läuft.
- `json_string()` escapet per Parameter-Expansion, NICHT per `sed`:
  Zeilenumbrüche und ANSI-Escapes müssen raus, sonst entsteht kaputtes JSON.
- `OMP_TIMEOUT=20` deckelt jeden omp-Aufruf; exit 124 wird als eigene
  Meldung gemeldet. Die Panel-Frist (25 s) liegt darüber.
- omps stderr wird über eine `mktemp`-Datei eingefangen und in die
  Fehlermeldung gehängt.
- PATH-Suche in dieser Reihenfolge: `command -v omp`,
  `~/.local/share/mise/shims/omp`, `~/.local/bin/omp`,
  `~/.bun/bin/omp`, `/usr/local/bin/omp`, `/usr/bin/omp`, zuletzt
  `mise which omp`.
- Vorspann-Sed: `sed -n '/^[[:space:]]*{/,$p'` schneidet Banner/Warnings
  vor dem JSON ab.

### Manifest (`manifest.json`)

- `schemaVersion: 1`, `id` matched Verzeichnisname (`cabroe.omp-quota`).
- `defaults` + `schema[]` MÜSSEN synchron sein (jeder Setting-Key in
  beiden mit gleichem `defaultValue`, `min`/`max`/`step` wo relevant).
- `barWidget.defaultSection: "right"`, `allowMultiple: false`.

## Important Files

|Datei|Rolle|
|---|---|
|`manifest.json`|Plugin-Identität, Settings-Schema|
|`Panel.qml`|UI, Lifecycle, IPC, Refresh-Logik, Error-Handling|
|`Usage.js`|JSON → Render-Modell|
|`usage.sh`|`omp`-Aufruf, PATH-Auflösung, Zeitlimit, JSON-Garantie|
|`README.md`|Bedienung, Dev-Notizen, Tests|

Entry-Point für die Bar ist ausschließlich `Panel.qml`. Es gibt keinen
zusätzlichen Bootstrap-Code.

## Runtime/Tooling Preferences

- **Runtime:** Quickshell (Qt/QML 6.x) innerhalb der Omarchy-Shell.
- **Shell:** `bash` für `usage.sh` (keine POSIX-only-Konstrukte nötig,
  aber `set -o pipefail` aktiv).
- **Test-Tooling:** `bun test` (`bun:test`); kein Node/npm.
- **Paketmanager:** keiner — kein `package.json`, keine `Cargo.toml`,
  keine `pyproject.toml`.
- **Tooling-Constraints:**
  - Keine externen Abhängigkeiten außer `omp` (Binary auf PATH oder
    installiert), coreutils (`timeout`, `mktemp`) und `mise`/`bun`.
  - `omarchy restart shell` für jede Code-Änderung, sonst läuft die alte
    Instanz weiter.
  - `settings` wird vom Bar-Host injiziert — vor dem ersten Abruf noch
    nicht vorhanden, siehe `requestRedact`.

## Testing & QA

- **Test-Framework:** `bun test` gegen `tests/`. `Usage.js` wird als
  `.pragma library` per `new Function` geladen, `usage.sh` gegen ein
  Fake-omp in einem temporären PATH gefahren.
- **Falle beim Not-found-Pfad:** Ein PATH, der `/usr/bin` enthält, findet
  `mise` und damit über `mise which omp` das echte omp — der Test ruft dann
  eine Provider-API. Deterministisch wird er nur mit isoliertem PATH
  (Symlinks auf `sed`, `mktemp`, `rm`, `timeout`), `mise`-Stub und
  absolutem `/bin/bash`-Aufruf.
- **Smoke-Tests für AI-Agents / Maintainer:**
  1. `./usage.sh` muss immer valides JSON auf stdout liefern (auch wenn
     `omp` fehlt: `{"error": "omp nicht gefunden ..."}`).
  2. `./usage.sh | head -c1` darf nicht leer sein und nicht mit einem
     Warn-Banner beginnen.
  3. `bun test` muss grün sein.
  4. Nach `redact`-Toggle muss ein neuer Abruf redigierte Konten zeigen
     (Präfix endet auf `*`); ein noch laufender Abruf mit der alten
     Einstellung wird verworfen, nicht angezeigt.
  5. Bei fehlendem `usage.sh` darf das Panel NICHT dauerhaft „wird geladen"
     anzeigen — `failFetch()` muss kurz darauf die Fehlerkarte zeigen.
  6. Ein hängendes `omp` darf das Widget nicht verklemmen: nach dem
     Watchdog muss ein erneutes `r` einen neuen Prozess starten.
- **Was kein Test ersetzt:** visueller Check nach `omarchy restart
  shell` (Bar-Layout, Popup-Scrollen, Meter-Animation, Alarmfarbe ab
  `alarmThreshold`).

## Gotchas (aus README, hier als AI-Anti-Pattern-Checkliste)

- **Niemals** die geerbte `setting()`-Helper benutzen — Bindings bleiben
  nicht reaktiv.
- **Niemals** einen geratenen Timer für die `settings`-Injektion — das ist
  ein Rennen gegen den Host. Stattdessen den Abruf korrigieren
  (`requestRedact`).
- **Niemals** eine Refresh-Anfrage verwerfen, weil gerade ein Abruf läuft —
  merken und nachziehen.
- **Niemals** annehmen, `Process.onExited` feuert für nicht-startende
  Prozesse; stattdessen `onRunningChanged` auswerten + Watchdog.
- **Niemals** einen hängenden Prozess nur abschreiben — der Watchdog MUSS
  `running = false` setzen, sonst blockiert er jeden weiteren Abruf.
- **Niemals** ein JS-Array als Repeater-Modell für animierte Inhalte —
  Delegates werden zerstört und `Behavior` greift beim Initialwert nicht.
- **Niemals** JSON per `sed` escapen — Zeilenumbrüche und ANSI-Escapes
  erzeugen ungültige Objekte.
- **Niemals** Sortierung nach Füllstand — Liste springt bei jedem
  Refresh.
- **Niemals** `omp`-Aufruf ohne PATH-Suche direkt aus QML.
- **Niemals** `omp` ohne Zeitlimit aufrufen.
- **Niemals** annehmen, dass Datei-Speichern das Widget neu lädt —
  `omarchy restart shell` ist Pflicht.
