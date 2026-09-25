---
name: omp-quota-provider
description: "Einen neuen omp-Provider im Bar-Plugin cabroe.omp-quota anlegen oder einen bestehenden korrigieren. Auslöser: neuer Provider in omp usage --json taucht nicht oder falsch im Widget auf, falsche Schreibweise in der Popup-Kopfzeile, ein Fenster mit dauerhaft 0 % das kein echtes Kontingent ist, Arbeit an providers/*.js, Providers.js, resolve(), stripTokens(), unlimitedWindows. Enthält Entscheidungsregel (Plugin nötig oder ableitbar?), Descriptor-Vertrag, Registry-Eintrag, Tests und Abnahme."
---

# Provider im Plugin cabroe.omp-quota anlegen

Arbeitsverzeichnis: `~/.config/omarchy/plugins/cabroe.omp-quota`.

Architektur: `Panel.qml` → `Usage.js` (providerfrei) → `.import "Providers.js"` → `.import "providers/*.js"`.
Jedes Plugin trägt **nur, was omps Report nicht hergibt**. Alles Ableitbare wird abgeleitet.

## 1. Erst prüfen: braucht der Provider überhaupt ein Plugin?

Die meisten brauchen keins. `resolve(id)` bedient jede ID vollständig, auch ohne Datei.
Ein Plugin rechtfertigt sich über genau zwei Dinge:

| Grund | Prüfung |
|---|---|
| **Schreibweise** | `fallbackName(id)` liegt daneben (`zai` → „Zai" statt „Z.ai") |
| **Quirk** | omp meldet ein Fenster, das kein Kontingent ist (siehe Abschnitt 4) |

Trifft keines zu: **keine Datei anlegen**. Ein Plugin, das nur den ableitbaren Namen
wiederholt, ist toter Eintrag (`anthropic`, `google-antigravity` haben deshalb keins).

Ableitung prüfen — zeigt Anzeigename und die abgeleiteten Strip-Tokens:

```sh
bun -e 'const {load}=await import("./tests/load.js");
const p=load("../Providers.js",["fallbackName","resolve"]);
const id="mistral-code";
console.log(p.fallbackName(id), JSON.stringify(p.resolve(id).strip));'
```

## 2. Rohdaten des Providers ansehen

Nie nach Gefühl entscheiden — omps Felder sind pro Provider unterschiedlich:

```sh
omp usage --json --provider <id> | jq '.reports[0]'
omp usage --history --days 30 --provider <id>   # deckt Phantom-Fenster auf
```

Relevant sind: `report.provider` (= die `id`), `limits[].label`, `limits[].window.id`,
`limits[].amount`, `metadata` (`planType` / `orgName` / `projectId` / `models`).

Zeigt der Verlauf ein Fenster über viele Snapshots bei exakt 0,0 %, während ein anderes
Fenster desselben Providers läuft, ist das der Phantom-Fall aus Abschnitt 4.

## 3. Plugin-Datei anlegen

`providers/<CamelCase>.js`, ein Top-Level-Export `descriptor`:

```js
.pragma library

// <Warum es diese Datei gibt: abweichende Schreibweise und/oder Quirk.
// Begründung gegen die echten Labels prüfen, nicht erfinden.>
var descriptor = {
  id: "mistral-code",
  name: "Mistral Code"
};
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `id` | ja | omps Provider-ID (`report.provider`). Exakt übernehmen. |
| `name` | ja | Anzeigename der Popup-Kopfzeile. |
| `unlimitedWindows` | nein | Fenster-IDs ohne echtes Kontingent (Abschnitt 4). |

Nicht ins Plugin gehört:

- **`strip`** — `stripTokens(id, name)` in `Providers.js` leitet die Tokens aus ID und
  Anzeigenamen ab und dedupliziert case-insensitiv. Handlisten waren zu 6 von 7
  Einträgen tot, weil omps echte Labels den Provider gar nicht nennen
  (`Claude 5 Hour`, `General 7 Day`, `30 days`).
- **Plan-, Org-, Projekt- oder Modellauskunft** — `accessLabel()` in `Usage.js` ist
  providerunabhängig und deckt alle Metadatenformen ab.

## 4. Phantom-Fenster (`unlimitedWindows`)

Nur für Fenster, die omp aus Anbieterfeldern ableitet, die **kein** Kontingent
beschreiben. Beleg-Beispiel MiniMax: das Wochenlimit ist laut Anbieter-Dashboard
„Unlimited", die API liefert trotzdem `current_weekly_remaining_percent: 100`, und omp
rechnet daraus `(100 - 100) / 100` = 0. Im JSON ist das von einem echten, frisch
zurückgesetzten Fenster **nicht** unterscheidbar — deshalb lokales Wissen:

```js
var descriptor = {
  id: "minimax-code",
  name: "MiniMax Code",
  unlimitedWindows: ["7d"]
};
```

Fenster-ID ist `window.id`, ersatzweise `scope.windowId`. `isUnlimited()` greift nur bei
**exakt** 0 %: sobald der Anbieter dort echten Verbrauch meldet, zählt die Zeile wieder
als Kontingent. Die Zeile wird nicht gelöscht, sondern als `∞ unbegrenzt` gezeigt —
„Fenster fehlt" wirft die Frage auf, die „unbegrenzt" beantwortet.

Bevor du hier etwas einträgst: `omp usage --history` als Beleg heranziehen. Ein einzelner
0-%-Snapshot ist nur ein frisch zurückgesetztes Fenster.

## 5. Registry synchronisieren

Ein einziger Befehl — `scripts/sync-providers.js` schreibt den markierten Block
in `Providers.js` (Imports + `PLUGINS`) alphabetisch selbst und lädt dabei jede
Datei zur Validierung (fehlende `id`/`name`, verbotenes `strip` brechen ab):

```sh
bun scripts/sync-providers.js
```

Nichts an `Providers.js` von Hand editieren: der Drift-Test
(`tests/providers.test.js`, `--check`) schlägt sonst an. QML verlangt statische
`.import`-Zeilen, deshalb der Generator statt Laufzeit-Autoerkennung.

## 6. Tests erweitern

`tests/providers.test.js`:

- Plugin angelegt → Eintrag in `KNOWN` mit erwartetem `name` und den **abgeleiteten**
  `strip`-Tokens.
- Kein Plugin, aber Provider soll belegt sein → Eintrag in `DERIVED`.
- Phantom-Fenster → der Test „Phantom-Fenster führt ausschließlich MiniMax' '7d'"
  ist bewusst eng; er muss mitgeändert werden und die Änderung ist eine
  Verhaltensaussage, keine Formalität.

Der Registry-Konsistenztest vergleicht `providers/*.js` gegen `PLUGINS` und fängt
„Datei angelegt, Import vergessen" von selbst — dafür ist nichts zu tun.

## 7. Abnahme (alle vier, in dieser Reihenfolge)

```sh
bun test
bun scripts/analyze.js      # exit 0 = sauber
```

`scripts/analyze.js` prüft genau die Fehler, die hier entstehen:

| Regel | fängt |
|---|---|
| `provider-registry` | Datei ohne `.import`, `.import` ohne `PLUGINS`-Eintrag, Import auf nicht existierende Datei, unsortierte Imports |
| `plugin-discipline` | Descriptor ohne `id`/`name`, Plugin mit eigenem `strip` |
| `provider-coverage` | Plugin, dessen `name` gleich `fallbackName(id)` ist und das keine `unlimitedWindows` trägt — tote Datei; außerdem Plugin ohne Beleg in `tests/providers.test.js` |
| `skill` | diese Skill nennt eine Funktion, die es nicht mehr gibt |

Ein Plugin, das `provider-coverage` auslöst, ist Abschnitt 1 zum zweiten Mal:
Datei löschen, nicht die Regel drehen.

Qt-Runtime: die `.import`-Kette scheitert in `bun` nie, in QML schon (Tippfehler im
Pfad, ES6-Syntax). Temporäre Datei im Plugin-Wurzelverzeichnis, Exit 42 = ok:

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

Laufende Shell (Dateispeichern lädt das Widget NICHT neu):

```sh
omarchy restart shell && sleep 4 && omarchy-shell cabroe.omp-quota open
grim /tmp/quota.png        # Kopfzeile, Zeilen, Meter prüfen
omarchy-shell cabroe.omp-quota close
```

## Anti-Patterns

- **Providerwissen in `Usage.js`** — der Kern ist providerfrei. Keine Namenstabelle,
  keine Strip-Liste, keine Fenster-ID.
- **ES6 in den JS-Libraries** — QML-Dialekt: nur `var` und `function`. Kein
  `let`/`const`, keine Arrow-Functions, keine Template-Strings, kein Spread. Der
  Test-Loader erkennt Exporte per Regex auf genau diese zwei Formen.
- **`resolve()` Teilobjekte liefern lassen** — der Kern prüft nichts nach.
- **Kommentare mit erfundenen Labels** — Begründungen gegen
  `omp usage --json` prüfen.
- **Plugin für einen ableitbaren Namen** — siehe Abschnitt 1.
- **`omarchy restart shell` überspringen** — QML-Fehler zeigen sich erst dort.

## Nicht hier, sondern in `skill://omp-quota-plugin`

Alles, was nicht providerspezifisch ist: Einstellungen anlegen,
Fetch-Lifecycle und Watchdog, Farbrampe und Layout, `usage.sh`, Bar-Label,
und die Regel, dass pure Logik nach `Usage.js` gehört statt als
Inline-Ausdruck in `Panel.qml` zu bleiben.
