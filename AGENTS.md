# Repository Guidelines

Omarchy-Bar-Plugin **cabroe.omp-quota** — zeigt Kontingente des `omp`-Agenten
([oh-my-pi](https://github.com/can1357/oh-my-pi)) für Anthropic, Z.ai, Google
Antigravity, MiniMax Code, OpenAI Codex, OpenRouter und GitHub Copilot in
einem Bar-Widget samt Popup.

## Project Overview

- **Zweck:** `omp usage --json` ausführen, das Ergebnis auf eine
  einheitliche Form bringen, in der Bar das knappste Fenster (Prozent) und
  im Popup jedes Fenster mit Füllstand, Status, Reset-Countdown und Zugang
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
   ▲                                │                       │
   │                                ▼                       ▼
refresh() (poll / open / r / R /    Providers.js          render
right-click / middle-click)         .resolve(id)
                                   → descriptor
                                   (name, strip,
                                    unlimitedWindows)
```

1. **Trigger:** `Component.onCompleted`, `pollTimer`
   (`refreshIntervalSec`), `onOpenedChanged`, Mittelklick / `r` (refresh),
   Rechtsklick / `R` / `f` (refresh mit `--fresh`), `onRedactChanged`.
2. **Prozess:** `Process { id: usageProcess }` ruft `/bin/bash usage.sh` mit
   optional `--redact` und/oder `--fresh` auf. `usage.sh` lokalisiert `omp`
   (Hyprland-PATH ist nicht Login-PATH) und führt `omp usage --json` unter
   `timeout -k 2 20` aus (2 s KILL-Gnade für ein TERM-ignorierendes omp;
   die KILL-Phase meldet exit 137 und wird wie 124 behandelt). Bei `--fresh`
   wird vorher `omp usage invalidate` mit eigenem Kurz-Budget (3 s) aufgerufen.
3. **JSON-Pfad:** `usage.sh` garantiert, dass stdout immer ein JSON-Objekt
   ist (im Fehlerfall `{"error": "..."}`, inklusive omps stderr). Eine
   Vorspann-Sed-Pipeline schneidet auf das erste `{` zu; ergibt das nichts,
   ist es ebenfalls ein Fehlerobjekt.
4. **Normalisierung:** `Usage.js` (`pragma library`, reine Funktionen,
   ohne QML-Abhängigkeit) glättet fünf Eigenheiten des Rohreports:
   uneinheitliche Mengenangaben → `usedFraction` als Wahrheit;
   `scope.sharedGroup` (Google Antigravity) wird per `dedupe()` auf eine
   Zeile reduziert (höchster Füllstand gewinnt); Labels werden von
   redundanten Provider-/Fenstertokens befreit; ein providerübergreifend
   gleiches Konto wandert per `collapseAccounts()` nach `sharedAccount`;
   ein Fenster ohne Kontingent wird als `unlimited` markiert statt als
   0-%-Limit — welche Fenster das pro Provider sind, hält jetzt das
   jeweilige Provider-Plugin in `providers/` (`unlimitedWindows`), nicht
   mehr `Usage.js`.
5. **Provider-Registry:** `Providers.js` aggregiert die Plugins in
   `providers/<Name>.js` zu `PLUGINS`, baut darauf eine `BY_ID`-Map und
   liefert `resolve(id)` immer einen vollständigen Descriptor (Name,
   Strip-Tokens, Phantom-Fenster). `Usage.js` ruft pro Report einmal
   `resolve(report.provider)` und reicht den Descriptor an
   `normalizeLimit` / `dedupe` weiter; unbekannte Provider erhalten einen
   Fallback-Descriptor, dessen Name aus der ID per `[-_.]`-Trennung
   automatisch entsteht (`fallbackName`). Der Kern enthält NULL
   Providerwissen.
6. **Render:** `Panel.qml` zeigt `worst` (knappster Wert über alle
   Provider) als Zahl in der Bar; im Popup je Provider eine Liste nach
   `durationMs` (kurz zuerst), je Limit Titel + Status/Absolutwert +
   Reset-Countdown + Prozent + Meter-Animation.
7. **Fehlerstrategie:** `fetchError` ist getrennt vom `report`; bei Fehler
   bleiben die letzten Zahlen sichtbar, der Fehler steht daneben.
   `failFetch()` läuft sowohl bei `onRunningChanged` (Skript fehlt) als auch
   nach 25 s Watchdog (Hänger) — und der Watchdog **killt** den Prozess.

## Key Directories

|Pfad|Zweck|
|---|---|
|`manifest.json`|Plugin-Metadaten + Settings-Schema (Single Source of Truth für UI-Optionen)|
|`Panel.qml`|Einziger Entry Point: `WidgetButton` (Bar) + `KeyboardPanel` (Popup)|
|`Usage.js`|Reine Normalisierungsfunktionen, `.pragma library` — providerfrei, holt Strip-Tokens und Phantom-Fenster aus der Registry|
|`Providers.js`|Aggregator: importiert alle Plugins in `providers/`, hält `PLUGINS` und die `BY_ID`-Map, exportiert `resolve(id)` und `fallbackName(id)`|
|`providers/`|Ein Plugin je Provider, dessen Anzeigename oder Verhalten von der Ableitung abweicht: `Zai.js`, `OpenAICodex.js`, `OpenRouter.js`, `GitHubCopilot.js` (Schreibweise), `MinimaxCode.js` (Schreibweise + Phantom-Fenster). `anthropic` und `google-antigravity` brauchen keins — ihr Name fällt aus der ID|
|`usage.sh`|PATH-robuster Wrapper um `omp usage --json`, mit Zeitlimit|
|`tests/`|`bun test`-Suiten: `usage.test.js`, `usage-sh.test.js`, `manifest.test.js`, Registry-Konsistenztest; `load.js` lädt QML-`.pragma library`-Dateien für die Suite|
|`.omp/skills/omp-quota-provider/`|Projekt-Skill (native Provider, `.omp/skills/*/SKILL.md`): Ablauf zum Anlegen eines Providers — Entscheidungsregel, Descriptor-Vertrag, Registry-Eintrag, Tests, Abnahme. Lesen per `skill://omp-quota-provider`|
|`README.md`|Doku, Bedienung, IPC, Settings, Dev-Notizen, „Provider hinzufügen"|
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
- Wiederverwendbare Blöcke als eigenständige `component`s am Dateiende:
  `ProviderSection: Column { … }` für einen Provider-Abschnitt (Trennlinie
  + Kopfzeile + Limit-Repeater) und `LimitRow: Column { … }` für die Zeile
  (Titel + Status/Absolutwert + Reset + Prozent + Meter). Der Popup-Baum
  bleibt dadurch flach genug, um ihn am Stück zu lesen.
- Geschwister NIE über `parent.children[N]` adressieren — ein neues Element
  davor verschiebt den Index und bricht das Layout still. `id` vergeben
  (`providerTitle`, `providerMeta`).
- Mehrfach gebrauchte Layout-Terme einmal benennen (`titleRow.tailWidth`):
  Titelbreite und Spacer müssen exakt denselben Wert abziehen, sonst
  driften sie beim nächsten Eingriff auseinander.
- Lange Properties: `borderSpec`, `anchors.baseline` für Detail/Reset/
  Prozent auf Titel-Baseline.
- `Behavior on width { NumberAnimation { duration: 160; easing.type:
  Easing.OutCubic } }` für die Meter-Füllung — funktioniert nur mit dem
  Count-Modell oben.

### JavaScript (`Usage.js`, `Providers.js`, `providers/*.js`)

- `.pragma library` als erste Zeile (eigenständige Library, kein QML);
  Imports anderer Libraries folgen direkt darunter als `.import "pfad.js"
  as NS`. Keine ES6-Syntax: kein `let`/`const`, keine Arrow-Functions,
  keine Template-Strings, keine `class`, kein `Object.assign`, kein Spread.
  Nur `var` und `function` — der Test-Loader erkennt Exporte genau über
  diese zwei Formen.
- **Providerwissen lebt NUR in `providers/<Name>.js`** — und dort nur, was
  omps Report NICHT hergibt: `var descriptor = { id, name }` plus optional
  `unlimitedWindows`. `Providers.js` importiert alle Plugins alphabetisch,
  führt sie in `PLUGINS` zusammen und baut daraus die `BY_ID`-Map mit
  bereits vervollständigten Descriptoren. `resolve(id)` liefert IMMER alle
  vier Felder (`id`, `name`, `strip`, `unlimitedWindows`), damit der Kern
  nie gegen fehlende Felder prüfen muss; unbekannte IDs erhalten einen
  Fallback-Descriptor, dessen Name per `[-_.]`-Trennung in
  `fallbackName(id)` entsteht (`some-new-provider` → `Some New Provider`;
  leer/fehlend → `Unbekannt`). `Usage.js` enthält NULL Providerwissen.
- `strip` steht NICHT im Plugin: `stripTokens(id, name)` leitet die Tokens
  aus ID **und** Anzeigenamen ab und dedupliziert case-insensitiv. Grund:
  omps echte Labels führen den Provider fast nie („Claude 5 Hour",
  „General 7 Day", „30 days") — von sieben Handlisten feuerte genau eine
  („ZAI 5 Hours Token Quota"), und deren Token steckt in der ID. Beide
  Quellen sind nötig, weil der Name Schreibweisen trägt, die die ID nicht
  hergibt („Z.ai" mit Punkt). Der synthetische Fallback-Name geht NICHT in
  die Tokens, sonst wäre „Unbekannt" bei leerer ID ein Strip-Token.
- Ein Plugin gibt es nur, wo `fallbackName(id)` danebenliegt (`zai` →
  „Zai", `minimax-code` → „Minimax Code") oder ein Quirk dazukommt.
  `anthropic` und `google-antigravity` brauchen deshalb KEINE Datei — eine
  anzulegen, die nur den ableitbaren Namen wiederholt, ist toter Eintrag.
- Eine Provider-Datei ohne `PLUGINS`-Eintrag in `Providers.js` ist stumm:
  der Registry-Konsistenztest fängt das.
- `resolve()` darf KEINE Teilobjekte liefern — Kerncode vertraut auf
  vollständige Felder und prüft nichts nach.
- Reine Funktionen in `Usage.js`, keine Closures, keine `Date.now()`
  direkt (Wert kommt rein — Testbarkeit).
- Regex-Escaping Pflicht beim Token-Strip (`token.replace(/[.*+?^${}()|
  [\]\\]/g, "\\$&")`).
- `num(value)` als zentraler `Number()`-Wrapper — aber NICHT für
  null/""/boolean: `Number(null)` & Co. sind 0, ohne den Guard würde ein
  JSON-null als 0 % oder Reset „jetzt" erscheinen statt als „keine Angabe"
  (NaN). `clamp(value, lo, hi)` für 0..1-Bounds.
- Sortierreihenfolge NIE nach Füllstand (Liste würde bei jedem Refresh
  springen). Provider alphabetisch (`a.name.localeCompare(b.name, "en")`),
  Limits nach `durationMs` aufsteigend.
- `accessLabel()` füllt den Zugangs-Slot der Kopfzeile mit **genau einer**
  Angabe, immer im Format „Substantiv Wert": `planType` („Plan lite") →
  `orgName` („Org …") → `projectId` („Projekt …") → `models` minus
  `unavailableModels` („Modell(e) …"). Das Substantiv ist Pflicht, auch
  beim Plan: ohne es standen in derselben Spalte ein nackter Planname und
  eine beschriftete Angabe nebeneinander. `orgName` NUR ohne `planType` —
  bei OpenAI Codex ist `orgName` gleich `free` (Dopplung), und bei
  Consumer-Accounts steht dort der Name der Person, der als Plan gelesen
  wie ein Tarif aussah („Anthropic · Ada Lovelace"). Es gibt KEIN `plan`-
  und kein `scope`-Feld mehr: ein Slot, ein Feld (`provider.access`).
- `STATUS_LABELS` spiegelt omps Vokabular (`ok`, `warning`, `exhausted`,
  `unknown`); unbekannte Werte werden unverändert durchgereicht.
- Phantom-Fenster ohne Kontingent (MiniMax' 7-Tage-Fenster, das omp aus
  `current_weekly_remaining_percent: 100` ableitet — 20/20 Verlaufs-
  Snapshots 0,0 %, während 5 h auf 35 % lief) werden jetzt im
  Provider-Plugin unter `descriptor.unlimitedWindows` geführt, nicht in
  `Usage.js`. `isUnlimited(plugin, entry, fraction)` greift nur bei
  **exakt** 0 % UND wenn die Fenster-ID in `plugin.unlimitedWindows` steht
  — echter Verbrauch macht die Zeile wieder zum Limit. Die Zeile wird
  NICHT gelöscht: „Fenster fehlt" wirft die Frage auf, die „unbegrenzt"
  beantwortet. `fraction: -1` blendet den Meter aus und verliert jeden
  `worst`-Vergleich, `resetsAt: NaN` unterdrückt den Countdown — das
  Wochenende ohne Limit ist kein Reset.
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
- `OMP_TIMEOUT=20` deckelt den usage-Aufruf (`timeout -k 2 20`), das
  `--fresh`-invalidate ein eigenes 3-s-Budget; exit 124 und 137 (KILL-Phase)
  werden als Timeout-Meldung gemeldet — inklusive des bereits eingelesenen
  stderr-Details. Die Panel-Frist (25 s) liegt über dem Normalfall; nur wenn
  BEIDE `--fresh`-Aufrufe TERM ignorieren, übernimmt der Watchdog.
- stdout wird beim Einlesen auf 5 MB gekappt (`head -c 5000000`), stderr
  auf 2 KB — sonst kann ein ausartender omp die JSON-Garantie per OOM
  brechen. Mit `set -o pipefail` überlebt der Exit-Status des Normallaufs
  die Pipeline.
- omps stderr wird über eine `mktemp`-Datei eingefangen und in die
  Fehlermeldung gehängt.
- PATH-Suche in dieser Reihenfolge: `command -v omp`,
  `~/.local/share/mise/shims/omp`, `~/.local/bin/omp`,
  `~/.bun/bin/omp`, `/usr/local/bin/omp`, `/usr/bin/omp`, zuletzt
  `mise which omp`.
- Vorspann-Sed: `sed -n -E '/^[[:space:]]*\{(["}]|$)/,$p'` schneidet
  Banner/Warnings vor dem JSON ab. Nach der `{` muss ein objektöffnendes
  Zeichen folgen (`"`-Key, `}` oder Zeilenende) — sonst passierte ein
  Text-Banner wie `{warn} ...` als angeblicher Payload.

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
|`Usage.js`|JSON → Render-Modell (providerfrei)|
|`Providers.js`|Provider-Registry: `PLUGINS`, `BY_ID`, `resolve(id)`, `fallbackName(id)`|
|`providers/`|Ein `descriptor` je Provider mit abweichender Schreibweise oder Quirk (siehe `skill://omp-quota-provider`)|
|`usage.sh`|`omp`-Aufruf, PATH-Auflösung, Zeitlimit, JSON-Garantie|
|`README.md`|Bedienung, Dev-Notizen, Tests, „Provider hinzufügen"|

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

- **Test-Framework:** `bun test` gegen `tests/`. `Usage.js` und
  `Providers.js` sind `.pragma library`-Dateien mit `.import`-Ketten — sie
  werden über `tests/load.js` geladen, das rekursiv jede `.import`-Zeile
  auflöst und die exportierten `var`/`function`-Namen per Regex
  (`/^(?:var|function)\s+([A-Za-z_$][\w$]*)/gm`) einsammelt. `new Function`
  allein reicht nicht: es parst die `.import`-Direktive nicht, und ohne
  Auflösung scheitert `Providers.js` schon beim Laden.
- **Registry-Konsistenztest:** prüft für jedes `providers/*.js`, dass (a)
  die Datei einen Top-Level-`descriptor`-Export mit `id` und `name`
  deklariert und `strip` NICHT selbst mitbringt (sonst wäre die Ableitung
  umgangen), (b) `resolve(id)` daraus alle vier Felder vervollständigt,
  (c) die `id` in `Providers.js` per `.import` referenziert und in
  `PLUGINS` eingetragen ist, und (d) keine `id` in `PLUGINS` auf eine
  fehlende Datei zeigt. Fängt „Datei angelegt, Import vergessen" (Provider
  ist sonst still) und „Import eingetragen, Datei gelöscht" (Aggregation
  wirft beim Laden).
- **Fallback-Naming:** `fallbackName("some-new-provider")` →
  `"Some New Provider"` (Trenner `[-_.]`, leere Segmente überspringen,
  jedes Segment erstes Zeichen groß). Pin via Test, weil der Kern auf
  vollständige Descriptoren vertraut und nichts nachprüft.
- **`usage.sh` gegen Fake-omp:** in einem temporären PATH mit
  isolierten `sed`/`mktemp`/`rm`/`timeout`-Symlinks, `mise`-Stub und
  absolutem `/bin/bash`-Aufruf. Ohne diese Isolation findet `/usr/bin`
  `mise` und damit über `mise which omp` das echte omp — der Test ruft
  dann eine Provider-API.
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

- **Niemals** Providerwissen (Anzeigename, Strip-Token, Phantom-Fenster)
  in `Usage.js` zurückholen — der Kern ist providerfrei. Alles, was pro
  omp-Anbieter anders ist, gehört in `providers/<Name>.js` als
  `descriptor`. Eine Wiederbelebung von Name-/Strip-/Phantom-Tabellen in
  `Usage.js` wäre ein Rückschritt hinter den aktuellen Stand.
- **Niemals** eine Provider-Datei anlegen ohne gleichzeitigen
  `PLUGINS`-Eintrag in `Providers.js` — der Registry-Konsistenztest
  schlägt fehl und die Datei bleibt stumm (kein `resolve()`-Treffer,
  kein Render).
- **Niemals** ein Plugin anlegen, das nur den ableitbaren Anzeigenamen
  wiederholt (`anthropic`, `google-antigravity`), und **niemals** eine
  Strip-Liste von Hand pflegen: `stripTokens(id, name)` leitet sie ab.
  Die Handlisten waren zu sechs von sieben Einträgen tot, weil omps echte
  Labels den Provider gar nicht nennen („Claude 5 Hour", „General 7 Day").
  Ein Plugin rechtfertigt sich über abweichende Schreibweise oder einen
  Quirk, den omps Daten nicht ausdrücken — sonst nicht.
- **Niemals** ES6 in den JS-Libraries (`Usage.js`, `Providers.js`,
  `providers/*.js`): kein `let`/`const`, keine Arrow-Functions, keine
  Template-Strings, keine `class`, kein `Object.assign`, kein Spread.
  QML-JS-Dialekt, nur `var` und `function` — der Test-Loader erkennt
  Exporte per Regex auf genau diese zwei Formen und scheitert sonst
  stillschweigend.
- **Niemals** `resolve()` Teilobjekte liefern lassen — der Kern vertraut
  auf vollständige Felder (`id`, `name`, `strip`, `unlimitedWindows`)
  und prüft nichts nach. Unbekannte IDs gehen durch `fallbackName(id)`,
  nicht durch ein teilweise gefülltes Descriptor-Objekt.
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
  `running = false` setzen, sonst blockiert er jeden weiteren Abruf. Aber
  AUCH das reicht allein nicht: Quickshell setzt `running = false` als
  `QProcess::terminate()` um — SIGTERM an bash — und bash deferiert das,
  solange ein Vordergrund-Kind läuft; `timeout` ohne `-k` wartet endlos auf
  ein TERM-ignorierendes Kind. Der Watchdog setzt deshalb danach
  `usageProcess.signal(9)`: SIGKILL an bash, die einzige Quelle der
  stdout-Pipe — `finished` feuert garantiert, die Queue zieht nach.
  `signal()` guardt selbst gegen einen bereits toten Prozess.
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
