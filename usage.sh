#!/bin/bash

# Print the omp provider-usage report as JSON on stdout, always.
#
# The shell runs with Hyprland's PATH, which is not a login shell's PATH: omp
# is usually a mise shim, sometimes a plain binary in ~/.local/bin. Resolving
# it here — rather than trusting `command -v` inside a QML Process — keeps the
# plugin working no matter how the session was started.
#
# stdout is always a JSON object so the panel never has to distinguish "no
# output" from "broken output". Failures print {"error": "..."} and exit 1,
# and the message carries omp's own stderr: "exit 1" on its own never told
# anyone whether a token had expired or DNS was down.

set -o pipefail

# Wall-clock ceiling for one omp call. Measured on this machine: 0.3 s from
# omp's cache, 1.2 s with --fresh (every provider API re-queried). The panel's
# watchdog sits above this number, so the script normally gives up first and
# reports its own precise error. -k 2 gives a TERM-ignoring omp 2 s of grace
# before KILL — without it, timeout waits forever on exactly the hang class
# this ceiling exists for.
OMP_TIMEOUT=20
# --fresh runs two omp calls back to back, so the budgets add up. The
# invalidate drop gets its own short ceiling; failure stays non-fatal (a
# stale snapshot beats no snapshot). Only when BOTH calls ignore TERM does
# the combined worst case (5 s + 22 s) cross the panel's 25 s watchdog —
# and the QML side SIGKILLs as the last resort.
FRESH_INVALIDATE_TIMEOUT=3

errfile=""
trap '[[ -n $errfile ]] && rm -f "$errfile"' EXIT

# A JSON string literal, built with parameter expansion instead of sed. The
# previous sed pipeline escaped quotes and backslashes but passed newlines and
# terminal escapes through untouched, so any multi-line message produced two
# broken lines instead of one object.
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

  candidate=$(command -v omp 2>/dev/null) && [[ -n $candidate ]] && {
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

redact=0
fresh=0
while [[ $# -gt 0 ]]; do
  case "$1" in
  --redact) redact=1 ;;
  --fresh) fresh=1 ;;
  *) ;;
  esac
  shift
done

OMP=$(find_omp) || {
  emit_error "omp nicht gefunden (gesucht in PATH, mise-Shims, ~/.local/bin, ~/.bun/bin, /usr/local/bin, /usr/bin)"
  exit 1
}

# coreutils is a hard dependency of the distro, so `timeout` is effectively
# always there; reporting unbounded still beats refusing to report at all.
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

# A forced refresh drops omp's cached reports first; the provider APIs are then
# re-queried by the usage call below. Failure here is not fatal — a stale
# snapshot beats no snapshot.
if ((fresh)); then
  run_omp "$FRESH_INVALIDATE_TIMEOUT" usage invalidate >/dev/null 2>&1
fi

args=(usage --json)
((redact)) && args+=(--redact)

# stdout bekommt denselben OOM-Schutz wie stderr: Ein ausartender oder
# kompromittierter omp kann Gigabytes schreiben; head deckelt die Variable
# auf 5 MB. Mit pipefail überlebt der Exit-Status des normalen Laufs
# (< 5 MB, head liest bis EOF), nur der.pathologische Lauf wird zum Fehler.
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
[[ -n $errfile ]] && detail=$(head -c 2000 "$errfile" 2>/dev/null)

# 124 = TERM-Frist, 137 = KILL-Phase von -k (ein TERM-ignorierendes omp
# wird nach 2 s Gnade erschossen). Beides ist derselbe Fall: omp hat die
# Frist verpasst. Das bereits eingelesene stderr bleibt in der Meldung —
# Retry-Loops und API-Fehler erklären genau, warum nichts kam.
if ((status == 124 || status == 137)); then
  if [[ -n $detail ]]; then
    emit_error "omp usage --json hat nach ${OMP_TIMEOUT} s nicht geantwortet: $detail"
  else
    emit_error "omp usage --json hat nach ${OMP_TIMEOUT} s nicht geantwortet"
  fi
  exit 1
fi

if ((status != 0)) || [[ -z $report ]]; then
  if [[ -n $detail ]]; then
    emit_error "omp usage --json fehlgeschlagen (exit $status): $detail"
  else
    emit_error "omp usage --json fehlgeschlagen (exit $status), keine Fehlerausgabe"
  fi
  exit 1
fi

# Guard against omp printing a banner or warning ahead of the payload: keep
# everything from the first brace on, so a stray line cannot break JSON.parse.
# Der Range verlangt nach der `{` ein Zeichen, das ein Objekt eröffnet —
# ein Key-Anführungszeichen, die sofort schließende Klammer oder das
# Zeilenende bei Pretty-Print. Sonst passierte auch ein Text-Banner wie
# "{warn} cache stale" als angeblicher Payload (Exit 0, invalides JSON).
#
# Bekannte Grenze: Das schneidet nur den Vorspann ab. Text NACH dem
# JSON-Objekt (Trailing Garbage auf stdout) bliebe stehen und erreichte das
# Panel als invalides JSON — Usage.parse baut daraus einen lesbaren Fehler
# statt zu crashen. omp schreibt Warnungen auf stderr (landen in der
# Fehlermeldung), also ist das eine dokumentierte Grenze, kein Bug, den ein
# fragiler sed-Parser beheben sollte.
payload=$(printf '%s' "$report" | sed -n -E '/^[[:space:]]*\{(["}]|$)/,$p')

# Output without a brace anywhere was never a report, and the sed above cuts
# it down to nothing. Printing that empty result would break the single
# promise this script makes: stdout is a JSON object.
if [[ -z ${payload//[[:space:]]/} ]]; then
  emit_error "omp usage --json lieferte kein JSON-Objekt: $report"
  exit 1
fi

printf '%s\n' "$payload"
