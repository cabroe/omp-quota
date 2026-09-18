#!/bin/bash

# Print the omp provider-usage report as JSON on stdout, always.
#
# The shell runs with Hyprland's PATH, which is not a login shell's PATH: omp
# is usually a mise shim, sometimes a plain binary in ~/.local/bin. Resolving
# it here — rather than trusting `command -v` inside a QML Process — keeps the
# plugin working no matter how the session was started.
#
# stdout is always a JSON object so the panel never has to distinguish "no
# output" from "broken output". Failures print {"error": "..."} and exit 1.

set -o pipefail

emit_error() {
  printf '{"error":%s}\n' "$(
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/"/'
  )"
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
  emit_error "omp not found on PATH (looked in mise shims, ~/.local/bin, /usr/local/bin)"
  exit 1
}

# A forced refresh drops omp's cached reports first; the provider APIs are then
# re-queried by the usage call below. Failure here is not fatal — a stale
# snapshot beats no snapshot.
if ((fresh)); then
  "$OMP" usage invalidate >/dev/null 2>&1
fi

args=(usage --json)
((redact)) && args+=(--redact)

report=$("$OMP" "${args[@]}" 2>/dev/null)
status=$?

if ((status != 0)) || [[ -z $report ]]; then
  emit_error "omp usage --json failed (exit $status)"
  exit 1
fi

# Guard against omp printing a banner or warning ahead of the payload: keep
# everything from the first brace on, so a stray line cannot break JSON.parse.
printf '%s' "$report" | sed -n '/^[[:space:]]*{/,$p'
printf '\n'
