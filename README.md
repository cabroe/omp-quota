# omp Kontingente

[![tests](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml/badge.svg)](https://github.com/cabroe/omp-quota/actions/workflows/tests.yml)

Ein Bar-Widget und ein Popup für die Provider-Kontingente, die der
[omp](https://github.com/can1357/oh-my-pi)-Agent verwaltet. Die Bar zeigt das
knappste Kontingent über alle Provider, das Popup jedes einzelne Fenster mit
Füllstand, Reset-Countdown und Plan.

```
 46%        ← knappstes Kontingent, rot ab der Warnschwelle
```

## Warum nicht `omarchy.agents`

Das mitgelieferte `omarchy.agents` zeigt auch Nutzung, liest aber
ausschließlich die JSON-Records, die `omarchy-agent-usage-update` nach
`~/.local/state/omarchy/agents/usage/` schreibt — und dessen Collectors
decken Claude Code, Codex und Fireworks ab. Die Provider hinter omp
(Anthropic, Z.ai, Google Antigravity, MiniMax Code, OpenAI Codex, …) kommen
dort nicht vor.

Der naheliegende Weg wäre ein eigener Collector `omarchy-agent-usage-omp`,
dann wäre nur ein Skript nötig. Er ist versperrt:
`omarchy-agent-usage-update` iteriert ausschließlich über
`$OMARCHY_PATH/bin/omarchy-agent-usage-*`, und dieses Verzeichnis gehört dem
Paket — was dort liegt, ist beim nächsten `omarchy update` weg. Also ein
eigenständiges Plugin.

## Dateien

| Datei | Zweck |
|---|---|
| `manifest.json` | Plugin-Deklaration, Einstellungs-Schema |
| `Panel.qml` | Bar-Widget und Popup (der einzige Entry Point) |
| `Usage.js` | Normalisierung des omp-Reports, ohne QML-Abhängigkeiten |
| `usage.sh` | ruft `omp usage --json` auf, PATH-robust und mit Zeitlimit |
| `tests/` | `bun test`-Suiten für `Usage.js`, `usage.sh` und `manifest.json` |

## Datenquelle

`usage.sh` kapselt vier Dinge, die sonst im QML landen würden:

1. **PATH.** Die Shell läuft mit Hyprlands PATH, nicht mit dem einer
   Login-Shell. omp ist hier ein mise-Shim; das Skript sucht der Reihe nach
   `command -v omp`, die mise-Shims, `~/.local/bin`, `~/.bun/bin`,
   `/usr/local/bin`, `/usr/bin` und zuletzt `mise which omp`.
2. **Ein einziges Ausgabeformat.** stdout ist immer ein JSON-Objekt, auch im
   Fehlerfall (`{"error": "..."}`). Das Panel muss „keine Ausgabe" nie von
   „kaputte Ausgabe" unterscheiden. Ausgabe ohne geschweifte Klammer war
   nie ein Report und wird ebenfalls zum Fehlerobjekt.
3. **`--fresh`.** Verwirft zuerst omps Report-Cache, damit ein manueller
   Refresh die Provider-APIs wirklich neu befragt statt dieselben Zahlen aus
   dem Cache zu liefern.
4. **Zeitlimit und Diagnose.** `timeout -k 2 20` deckelt den Aufruf (2 s
   KILL-Gnade für ein TERM-ignorierendes omp), der Cache-Verwerfer bei
   `--fresh` bekommt ein eigenes 3-s-Budget, und omps stderr steht in der
   Fehlermeldung. „exit 1" allein hat nie verraten, ob ein Token abgelaufen
   oder DNS tot war.

`Usage.js` glättet vier Eigenheiten des Rohreports:

- Mengenangaben sind uneinheitlich — Anthropic liefert `used`/`limit`, ZAI
  für Token-Fenster nur `usedFraction`. Einzig `usedFraction` ist überall
  vorhanden und damit die Wahrheit.
- Google Antigravity meldet ein geteiltes Kontingent dreimal, einmal je
  Upstream-Modellfamilie, mit gemeinsamem `scope.sharedGroup`. Die Gruppe
  wird zu einer Zeile zusammengefasst (der höchste Füllstand gewinnt).
- Labels verdoppeln Provider- und Fenstername. Aus „ZAI 5 Hours Token Quota"
  im Fenster „5 Hours" wird `Token Quota · 5 Hours`, weil der Provider schon
  in der Abschnittsüberschrift steht.
- Dasselbe Konto steht in jedem Provider-Report. Ist es überall gleich,
  wandert es als `sharedAccount` einmal in die Fußzeile statt viermal in die
  Überschriften (im Redaktionsmodus viermal „ca*"). Unterscheiden sich die
  Konten, bleiben sie je Provider stehen — dann tragen sie Information.

Kontingente werden je Provider nach Fensterdauer sortiert (5 Stunden vor 7
Tagen vor 30 Tagen), Provider alphabetisch. Bewusst nicht nach Füllstand:
eine Liste, die ihre Reihenfolge mit jedem Refresh ändert, liest niemand.

## Was das Popup zeigt

Je Kontingent eine Zeile: Titel, dann — sofern vorhanden — Status und
Absolutwert, dann der Reset-Countdown, dann der Prozentwert und darunter der
Meter.

- **Status.** omp klassifiziert jedes Fenster als `ok`, `warning`,
  `exhausted` oder `unknown`. Alles außer `ok` steht als Wort in der Zeile
  („fast leer", „erschöpft", „unbekannt"); `exhausted` färbt sie zusätzlich.
  Das ist nötig, weil der Füllstand auf 100 % begrenzt ist — ein
  überzogenes Kontingent sähe sonst aus wie ein gerade eben volles.
- **Absolutwert.** Nur wo die Einheit keine Prozent sind. Z.ai zählt Zread
  in Anfragen, dort steht `1/100 Anfragen` neben dem „1 %".
- **Reset-Credits.** Prepaid-Guthaben, mit dem sich ein gesperrtes Fenster
  vorzeitig zurücksetzen lässt, steht in der Provider-Überschrift.
- **Plan.** omp meldet `metadata.planType` nur für Z.ai (`lite`) und OpenAI
  Codex (`free`). Für Anthropic, Google Antigravity und MiniMax Code gibt es
  keinen Plan — weder im Report noch in omps Credential-Store, und `omp
  usage` selbst zeigt dort ebenfalls kein `plan:`. Damit der Slot nicht leer
  bleibt, tritt die Angabe ein, die der Provider wirklich führt: `Org
  Carsten Bröckert` (Anthropic `orgName`), `Projekt aicode-consumers`
  (Antigravity `projectId`), `Modell general` (MiniMax `models` minus
  `unavailableModels`). Jede trägt ihr Substantiv, weil ein nackter
  Personenname im Plan-Slot wie eine Planbezeichnung aussieht — genau der
  Fehler, den `planLabel()` vermeidet.
- **Fußzeile.** Stand des Abrufs, geteiltes Konto, deaktivierte Zugänge,
  Konten ohne Daten, Tastenkürzel.

## Bedienung

| Aktion | Wirkung |
|---|---|
| Linksklick | Popup öffnen/schließen |
| Mittelklick | Aktualisieren |
| Rechtsklick | omp-Cache verwerfen und neu abrufen |
| `r` | Aktualisieren |
| `R` / `f` | Cache verwerfen und neu abrufen |
| `j` / `k`, ↑ / ↓ | Scrollen |
| Tab | Nachbar-Panel in der Bar |
| Esc | Schließen |

Eine Anfrage, die während eines laufenden Abrufs kommt, wird gemerkt und
danach ausgeführt — ein Rechtsklick im falschen Moment fällt nicht weg, und
`--fresh` gewinnt gegen einen parallel gemerkten Normalabruf.

Per IPC: `omarchy-shell cabroe.omp-quota <open|close|toggle>`.

## Einstellungen

```bash
omarchy bar set cabroe.omp-quota refreshIntervalSec 600 --json
omarchy bar set cabroe.omp-quota alarmThreshold 75 --json
omarchy bar set cabroe.omp-quota redact true --json
```

| Key | Default | Wirkung |
|---|---|---|
| `refreshIntervalSec` | `300` | Abrufintervall, 60–3600 s |
| `alarmThreshold` | `90` | Ab diesem Prozentwert werden Zahl und Meter in der Warnfarbe gezeichnet |
| `redact` | `false` | Ruft omp mit `--redact` auf: E-Mails und Konto-IDs werden auf ein eindeutiges Präfix gekürzt — für Screenshots |

Zahlen brauchen `--json`, sonst landen sie als Strings in `shell.json`.

## Tests

```bash
bun test
```

`Usage.js` ist eine `.pragma library` aus reinen Funktionen und wird in der
Suite per `new Function` geladen. `usage.sh` wird gegen ein Fake-omp in einem
temporären PATH gefahren. Wer den Not-found-Pfad testet, braucht einen
isolierten PATH mit Symlinks auf `sed`, `mktemp`, `rm` und `timeout` plus
einen `mise`-Stub — sonst löst der letzte Zweig von `find_omp`,
`mise which omp`, das echte omp auf und der Test ruft eine Provider-API.

## Entwicklungsnotizen

Fünf Fallen, die beim Bau dieses Plugins Zeit gekostet haben:

- **`setting()` aus `Ui/Panel.qml` ist in Bindings nicht reaktiv.** Der
  Property-Zugriff liegt in der Basiskomponente, also registriert ein Binding
  hier keine Abhängigkeit auf `settings` und behält seinen Startwert für
  immer. Deshalb greift dieses Plugin direkt auf `settings.<key>` zu, so wie
  die First-Party-Panels das auch tun.
- **`settings` kommt erst nach der Instanziierung.** Der erste Abruf läuft
  trotzdem sofort in `Component.onCompleted`. Schaltet die Injektion danach
  `redact` ein, verwirft `applyReport()` den unredigierten Report (der
  Aufruf merkt sich in `requestRedact`, mit welcher Einstellung er startete)
  und holt neu. Ein geratener Timer wäre ein Rennen gegen den Host.
- **`Process.onExited` feuert nicht, wenn das Programm nie startet**, und
  `running` allein reicht auch nicht: ein *hängender* Prozess meldet gar
  nichts. Der Watchdog muss ihn darum killen (`running = false`), sonst
  blockiert er jeden weiteren Abruf für immer, weil `refresh()` bei laufendem
  Prozess nur noch in die Queue schreibt. Die Frist (25 s) liegt über dem
  Limit in `usage.sh` (20 s), damit im Normalfall das Skript zuerst aufgibt
  und seinen genaueren Fehler melden kann.
- **`Behavior` greift beim Initialwert nicht.** Ein `Repeater`, dessen Modell
  ein JS-Array ist, zerstört bei jedem Abruf alle Delegates und baut sie neu
  — und ein neu gebautes Meter springt auf seinen Wert statt zu animieren.
  Deshalb iterieren die Repeater über einen Zähler (`providerCount`,
  `limitCount`) und lesen ihre Daten über den Index. Index-Identität ist hier
  tragfähig, weil die Reihenfolge deterministisch und ausdrücklich nicht
  füllstandsabhängig ist.
- **`WidgetButton` liest `tooltipText` genau einmal, bei `onEntered`.** Die
  Uhr für die Countdowns tickte nur bei offenem Panel, also zeigte der
  Tooltip die Alterung des letzten Abrufs so an, wie sie beim letzten Öffnen
  war. Sie läuft darum auch bei `hasError` — dem einzigen Fall, in dem der
  Tooltip eine Alterung nennt. Bewusst über den Zustand statt über ein
  Hover-Signal: ein Handler auf `tooltipHovered` hinge an der Reihenfolge
  von `containsMouse` und `entered()` innerhalb von Qt, und die ließ sich
  hier nicht messen (Hyprland sendet bei `input:mouse_refocus = false` auf
  programmatische Cursor-Warps kein Pointer-Enter).

**Code-Änderungen brauchen `omarchy restart shell`.** Das Speichern einer
Datei unter `~/.config/omarchy/plugins/` lässt die Registry neu einlesen
(„Local plugin changed, reloading"), ersetzt aber die laufende
Bar-Widget-Instanz nicht.
