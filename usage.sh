#!/bin/bash

# Gibt den omp-Provider-Nutzungsreport als JSON auf stdout aus — immer.
#
# Die Shell läuft mit Hyprlands PATH, nicht mit dem einer Login-Shell: omp
# ist meist ein mise-Shim, manchmal ein einfaches Binary in ~/.local/bin.
# Die Auflösung hier — statt `command -v` innerhalb eines QML-Process —
# hält das Plugin funktionsfähig, egal wie die Sitzung gestartet wurde.
#
# stdout ist immer ein JSON-Objekt, damit das Panel „keine Ausgabe" nie von
# „kaputte Ausgabe" unterscheiden muss. Fehler geben {"error": "..."} aus
# und beenden mit 1; die Meldung trägt omps eigenes stderr, denn „exit 1"
# allein hat nie verraten, ob ein Token abgelaufen oder DNS tot war.
#
# Ohne Argument der Live-Report. Mit `history` stattdessen omps stündliche
# Verlaufssnapshots (`--history --days 7`) — Grundlage der Sparklines im
# Popup. Mit `stats` die Session-Statistik (`omp stats --json`, letzte
# 24 h) für die Analyse-Ansicht. Alle Modi teilen sich Guards und
# JSON-Garantie.

set -o pipefail

# Wanduhr-Obergrenze für einen omp-Aufruf. Gemessen: 0,3 s aus omps Cache,
# 1,2 s mit --fresh (jede Provider-API neu befragt). Der Watchdog des Panels
# liegt über diesem Wert, das Skript gibt also im Normalfall zuerst auf und
# meldet seinen eigenen, genaueren Fehler. -k 2 gibt einem TERM-ignorierenden
# omp 2 s Gnade vor dem KILL — ohne das wartet timeout endlos auf genau die
# Hänger-Klasse, für die diese Obergrenze existiert.
OMP_TIMEOUT=20
# --fresh führt zwei omp-Aufrufe hintereinander aus, die Budgets addieren
# sich also. Das Verwerfen des Caches bekommt seine eigene kurze Grenze;
# ein Fehlschlag bleibt unkritisch (ein alter Snapshot schlägt keinen).
# Nur wenn BEIDE Aufrufe TERM ignorieren, überschreitet der kombinierte
# Worst Case (5 s + 22 s) den 25-s-Watchdog des Panels — und die QML-Seite
# schickt als letztes Mittel ein SIGKILL.
FRESH_INVALIDATE_TIMEOUT=3

errfile=""
trap '[[ -n $errfile ]] && rm -f "$errfile"' EXIT

# Ein JSON-String-Literal, gebaut per Parameter-Expansion statt per sed. Die
# frühere sed-Pipeline escapte Anführungszeichen und Backslashes, ließ aber
# Zeilenumbrüche und Terminal-Escapes unberührt — jede mehrzeilige Meldung
# erzeugte so zwei kaputte Zeilen statt eines Objekts.
json_string() {
  local s=${1:0:400}
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//[[:space:]]/ }
  s=${s//[[:cntrl:]]/}
  # Eine nicht-UTF-8-Locale (env -i, systemd-Unit, nicht generiertes LANG
  # fällt nach C) schneidet ${1:0:400} byteweise und zerteilt Multibyte-
  # Zeichen — die verwaisten Bytes machen das JSON unlesbar. iconv wirft
  # sie raus; fehlt iconv, bleibt der rohe String (QML dekodiert dann mit
  # U+FFFD statt zu brechen).
  if command -v iconv >/dev/null 2>&1; then
    s=$(printf '%s' "$s" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null || printf '%s' "$s")
  fi
  printf '"%s"' "$s"
}

emit_error() {
  printf '{"error":%s}\n' "$(json_string "$1")"
}

find_omp() {
  local candidate

  # Nur absolute Pfade: enthält PATH einen relativen Eintrag (klassisch "."
  # oder ein leeres Feld), liefert `command -v` einen relativen Treffer, und
  # das Skript läuft mit dem Plugin-Verzeichnis als cwd — eine dort
  # abgelegte Datei namens `omp` würde ausgeführt. Die feste Liste unten
  # fängt den Normalfall ohnehin ab.
  candidate=$(command -v omp 2>/dev/null) && [[ $candidate == /* && -x $candidate ]] && {
    printf '%s\n' "$candidate"
    return 0
  }

  for candidate in \
    "$HOME/.local/share/mise/shims/omp" \
    "$HOME/.local/bin/omp" \
    "$HOME/.bun/bin/omp" \
    /usr/local/bin/omp \
    /usr/bin/omp; do
    [[ -x $candidate ]] && {
      printf '%s\n' "$candidate"
      return 0
    }
  done

  if command -v mise >/dev/null 2>&1; then
    candidate=$(mise which omp 2>/dev/null) && [[ -n $candidate && -x $candidate ]] && {
      printf '%s\n' "$candidate"
      return 0
    }
  fi

  return 1
}

mode=live
redact=0
fresh=0
while [[ $# -gt 0 ]]; do
  case "$1" in
  --redact) redact=1 ;;
  --fresh) fresh=1 ;;
  history | stats)
    # Zwei verschiedene Modi in einem Aufruf sind ein Aufruffehler, kein
    # unbekanntes Flag: still den letzten gewinnen zu lassen lieferte
    # lautlos die falschen Daten (`usage.sh history stats` las die
    # Statistik, die Sparklines blieben leer).
    if [[ $mode != live && $mode != "$1" ]]; then
      emit_error "Widersprüchliche Modi: $mode und $1"
      exit 1
    fi
    mode=$1
    ;;
  # Unbekanntes bleibt folgenlos: Das Widget darf nicht erblinden, nur weil
  # ein künftiger Host ein Flag mehr mitschickt — eine Fehlerkarte statt der
  # Kontingente wäre der schlechtere Tausch. Festgehalten in
  # tests/usage-sh.test.js "unbekannte Flags brechen nichts".
  *) ;;
  esac
  shift
done

OMP=$(find_omp) || {
  emit_error "omp nicht gefunden (gesucht in PATH, mise-Shims, ~/.local/bin, ~/.bun/bin, /usr/local/bin, /usr/bin)"
  exit 1
}

# coreutils ist eine harte Abhängigkeit der Distribution, `timeout` ist also
# praktisch immer da; ohne Zeitlimit zu melden schlägt immer noch, gar nicht
# zu melden.
TIMEOUT=$(command -v timeout 2>/dev/null)

run_omp() {
  local limit=$1
  shift
  if [[ -n $TIMEOUT ]]; then
    "$TIMEOUT" -k 2 "$limit" "$OMP" "$@"
  else
    "$OMP" "$@"
  fi
}

errfile=$(mktemp 2>/dev/null) || errfile=""

if [[ $mode == history ]]; then
  # Trendmodus: omps eigene stündliche Snapshots aus der Aufzeichnung —
  # ein DB-Lese, kein Provider-API-Rundtrip. --fresh wäre hier bedeutungs-
  # los: die Verlaufszeilen gibt es schon, ein Invalidate würde nur den
  # Live-Cache opfern, von dem der Trendmodus nichts erbt.
  args=(usage --json --history --days 7)
elif [[ $mode == stats ]]; then
  # Statistikmodus: omps Session-Statistik der letzten 24 h (omps eigener
  # Default), inkl. der Präambel-Zeile "Synced ...", die die Sed-Pipeline
  # unten ohnehin abschneidet. --fresh hat hier keinen Cache, den es
  # lohnte zu leeren.
  args=(stats --json)
else
  # Ein erzwungener Refresh verwirft zuerst omps gecachte Reports; die
  # Provider-APIs werden dann vom usage-Aufruf unten neu befragt. Ein
  # Fehlschlag hier ist unkritisch — ein alter Snapshot schlägt keinen.
  if ((fresh)); then
    run_omp "$FRESH_INVALIDATE_TIMEOUT" usage invalidate >/dev/null 2>&1
  fi
  args=(usage --json)
fi
# `omp stats` kennt kein --redact: es nennt Modelle, keine Konten. Das Flag
# blind anzuhängen brach den Aufruf mit "Unknown option '--redact'" ab, und
# die Analyse-Ansicht blieb bei aktiver Redaktion leer.
if ((redact)) && [[ $mode != stats ]]; then
  args+=(--redact)
fi

# Das Kommando, das wirklich lief — Grundlage jeder Fehlermeldung unten.
# Vorher stand dort dreimal hartverdrahtet "omp usage --json", also
# behauptete ein gescheiterter Verlauf- oder Statistikabruf, `omp usage`
# sei gescheitert: eine Fehldiagnose genau in dem Moment, in dem die
# Meldung die einzige Spur ist.
label="omp ${args[*]}"

# stdout bekommt denselben OOM-Schutz wie stderr: Ein ausartender oder
# kompromittierter omp kann Gigabytes schreiben; head deckelt die Variable
# auf 5 MB. Mit pipefail überlebt der Exit-Status des normalen Laufs
# (< 5 MB, head liest bis EOF), nur der pathologische Lauf wird zum Fehler.
if [[ -n $errfile ]]; then
  report=$(run_omp "$OMP_TIMEOUT" "${args[@]}" 2>"$errfile" | head -c 5000000)
else
  report=$(run_omp "$OMP_TIMEOUT" "${args[@]}" 2>/dev/null | head -c 5000000)
fi
status=$?

# stderr-Intake auf die ersten Kilobytes deckeln: Ein hängendes omp kann
# während des gesamten OMP_TIMEOUT Megabytes in die Datei schreiben, und das
# ungefilterte Einlesen in eine Shell-Variable kann das Skript per OOM
# abreißen lassen — das würde die JSON-Garantie selbst brechen. Die
# 400-Zeichen-Kürzung in json_string() greift dafür zu spät.
detail=""
[[ -n "$errfile" && -f "$errfile" ]] && detail=$(head -c 2000 "$errfile" 2>/dev/null)

# 124 = TERM-Frist, 137 = KILL-Phase von -k (ein TERM-ignorierendes omp
# wird nach 2 s Gnade erschossen). Beides ist derselbe Fall: omp hat die
# Frist verpasst. Das bereits eingelesene stderr bleibt in der Meldung —
# Retry-Loops und API-Fehler erklären genau, warum nichts kam.
if ((status == 124 || status == 137)); then
  if [[ -n $detail ]]; then
    emit_error "$label hat nach ${OMP_TIMEOUT} s nicht geantwortet: $detail"
  else
    emit_error "$label hat nach ${OMP_TIMEOUT} s nicht geantwortet"
  fi
  exit 1
fi

# 141 = SIGPIPE: head hat seine 5 MB gelesen und die Pipe geschlossen, omp
# schreibt weiter und bekommt SIGPIPE. Das Teilstück ist mitten im Objekt
# abgeschnitten und damit so gut wie nie gültiges JSON — es weiterzureichen
# bräche die Zusage dieses Skripts und ersetzte die präzise Ursache durch
# ein generisches "kein JSON" weiter oben in Usage.parse.
if ((status == 141)); then
  emit_error "$label Ausgabe ueberschreitet 5 MB und wurde abgeschnitten"
  exit 1
fi

if ((status != 0)) || [[ -z $report ]]; then
  if [[ -n $detail ]]; then
    emit_error "$label fehlgeschlagen (exit $status): $detail"
  else
    emit_error "$label fehlgeschlagen (exit $status), keine Fehlerausgabe"
  fi
  exit 1
fi

# Schutz davor, dass omp ein Banner oder eine Warnung vor die Nutzlast
# schreibt: alles ab der ersten geschweiften Klammer behalten, damit eine
# verirrte Zeile JSON.parse nicht zerbricht.
# Der Range verlangt nach der `{` — optionale Leerzeichen übersprungen —
# ein Zeichen, das ein Objekt eröffnet: ein Key-Anführungszeichen, die
# schließende Klammer oder das Zeilenende bei Pretty-Print. Sonst passierte
# auch ein Text-Banner wie "{warn} cache stale" als angeblicher Payload
# (Exit 0, invalides JSON). Ohne das `[[:space:]]*` verwarf der Ausdruck
# ein völlig normales `{ "a": 1 }` samt Nutzlast.
#
# Bekannte Grenze: Das schneidet nur den Vorspann ab. Text NACH dem
# JSON-Objekt (Trailing Garbage auf stdout) bliebe stehen und erreichte das
# Panel als invalides JSON — Usage.parse baut daraus einen lesbaren Fehler
# statt zu crashen. omp schreibt Warnungen auf stderr (landen in der
# Fehlermeldung), also ist das eine dokumentierte Grenze, kein Bug, den ein
# fragiler sed-Parser beheben sollte.
payload=$(printf '%s' "$report" | sed -n -E '/^[[:space:]]*\{[[:space:]]*(["}]|$)/,$p')

# Eine Ausgabe ganz ohne geschweifte Klammer war nie ein Report, und das sed
# oben schneidet sie auf nichts zusammen. Dieses leere Ergebnis auszugeben
# bräche das einzige Versprechen dieses Skripts: stdout ist ein JSON-Objekt.
if [[ -z ${payload//[[:space:]]/} ]]; then
  emit_error "$label lieferte kein JSON-Objekt: $report"
  exit 1
fi

printf '%s\n' "$payload"
