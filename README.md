# omp Kontingente

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
| `usage.sh` | ruft `omp usage --json` auf, PATH-robust |

## Datenquelle

`usage.sh` kapselt drei Dinge, die sonst im QML landen würden:

1. **PATH.** Die Shell läuft mit Hyprlands PATH, nicht mit dem einer
   Login-Shell. omp ist hier ein mise-Shim; das Skript sucht der Reihe nach
   `command -v omp`, die mise-Shims, `~/.local/bin`, `~/.bun/bin`,
   `/usr/local/bin`, `/usr/bin` und zuletzt `mise which omp`.
2. **Ein einziges Ausgabeformat.** stdout ist immer ein JSON-Objekt, auch im
   Fehlerfall (`{"error": "..."}`). Das Panel muss „keine Ausgabe" nie von
   „kaputte Ausgabe" unterscheiden.
3. **`--fresh`.** Verwirft zuerst omps Report-Cache, damit ein manueller
   Refresh die Provider-APIs wirklich neu befragt statt dieselben Zahlen aus
   dem Cache zu liefern.

`Usage.js` glättet drei Eigenheiten des Rohreports:

- Mengenangaben sind uneinheitlich — Anthropic liefert `used`/`limit`, ZAI
  für Token-Fenster nur `usedFraction`. Einzig `usedFraction` ist überall
  vorhanden und damit die Wahrheit.
- Google Antigravity meldet ein geteiltes Kontingent dreimal, einmal je
  Upstream-Modellfamilie, mit gemeinsamem `scope.sharedGroup`. Die Gruppe
  wird zu einer Zeile zusammengefasst (der höchste Füllstand gewinnt).
- Labels verdoppeln Provider- und Fenstername. Aus „ZAI 5 Hours Token Quota"
  im Fenster „5 Hours" wird `Token Quota · 5 Hours`, weil der Provider schon
  in der Abschnittsüberschrift steht.

Kontingente werden je Provider nach Fensterdauer sortiert (5 Stunden vor 7
Tagen vor 30 Tagen), Provider alphabetisch. Bewusst nicht nach Füllstand:
eine Liste, die ihre Reihenfolge mit jedem Refresh ändert, liest niemand.

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

## Entwicklungsnotizen

Zwei Fallen, die beim Bau dieses Plugins Zeit gekostet haben:

- **`settings` kommt erst nach der Instanziierung.** Ein Abruf in
  `Component.onCompleted` läuft noch mit Standardwerten — sichtbar an
  unredigierten Konten trotz `redact: true`. Der erste Abruf wartet darum
  einen Timer-Tick.
- **`setting()` aus `Ui/Panel.qml` ist in Bindings nicht reaktiv.** Der
  Property-Zugriff liegt in der Basiskomponente, also registriert ein Binding
  hier keine Abhängigkeit auf `settings` und behält seinen Startwert für
  immer. Deshalb greift dieses Plugin direkt auf `settings.<key>` zu, so wie
  die First-Party-Panels das auch tun.
- **Code-Änderungen brauchen `omarchy restart shell`.** Das Speichern einer
  Datei unter `~/.config/omarchy/plugins/` lässt die Registry neu einlesen
  („Local plugin changed, reloading"), ersetzt aber die laufende
  Bar-Widget-Instanz nicht.
- **`Process.onExited` feuert nicht, wenn das Programm nie startet.** Fehlt
  oder ist `usage.sh` nicht ausführbar, protokolliert Quickshell nur „Process
  failed to start" und `running` fällt zurück — ohne `onExited`. Ein
  Fehlerzustand, der dort aufgeräumt wird, bleibt also für immer auf „wird
  geladen" stehen. Dieses Plugin wertet darum den Wechsel von `running` aus
  und hat zusätzlich eine Frist für den Fall, dass der Abruf hängt.

Die Normalisierung lässt sich ohne Shell testen, da `Usage.js` reine
Funktionen enthält:

```bash
./usage.sh > /tmp/report.json
bun -e 'const m=new Function(require("fs").readFileSync("Usage.js","utf8").replace(/^\.pragma\s+library\s*/,"")+"\nreturn {parse}")();
        console.log(JSON.stringify(m.parse(require("fs").readFileSync("/tmp/report.json","utf8")),null,2))'
```
