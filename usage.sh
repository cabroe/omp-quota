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
# watchdog sits above this number, so the process is always the first to give
# up — a hung omp that nobody kills blocks every later refresh.
OMP_TIMEOUT=20

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
  if [[ -n $TIMEOUT ]]; then
    "$TIMEOUT" "$OMP_TIMEOUT" "$OMP" "$@"
  else
    "$OMP" "$@"
  fi
}

errfile=$(mktemp 2>/dev/null) || errfile=""

# A forced refresh drops omp's cached reports first; the provider APIs are then
# re-queried by the usage call below. Failure here is not fatal — a stale
# snapshot beats no snapshot.
if ((fresh)); then
  run_omp usage invalidate >/dev/null 2>&1
fi

args=(usage --json)
((redact)) && args+=(--redact)

if [[ -n $errfile ]]; then
  report=$(run_omp "${args[@]}" 2>"$errfile")
else
  report=$(run_omp "${args[@]}" 2>/dev/null)
fi
status=$?

detail=""
[[ -n $errfile ]] && detail=$(<"$errfile")

if ((status == 124)); then
  emit_error "omp usage --json hat nach ${OMP_TIMEOUT} s nicht geantwortet"
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
payload=$(printf '%s' "$report" | sed -n '/^[[:space:]]*{/,$p')

# Output without a brace anywhere was never a report, and the sed above cuts
# it down to nothing. Printing that empty result would break the single
# promise this script makes: stdout is a JSON object.
if [[ -z ${payload//[[:space:]]/} ]]; then
  emit_error "omp usage --json lieferte kein JSON-Objekt: $report"
  exit 1
fi

printf '%s\n' "$payload"
