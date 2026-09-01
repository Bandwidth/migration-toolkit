#!/usr/bin/env bash
# Conformance check: validate the translator's BXML output against the official
# Bandwidth CLI (`band`). Two levels:
#   1. well-formedness — `band bxml raw` returns non-zero on malformed XML
#   2. (manual) schema — compare our verb/attribute names against the canonical
#      output of `band bxml speak|gather|transfer|record`
#
# Requires `band` on PATH (https://github.com/Bandwidth/cli). No auth needed —
# `band bxml` runs offline.
#
# NOTE on exit codes: read band's status directly (command in the if-condition),
# never `band ... | something; $?` — a pipe reports the LAST command's status,
# which masks band's. (This bit us once; see git history.)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v band >/dev/null 2>&1; then
  echo "band CLI not found on PATH — skipping BXML conformance check" >&2
  exit 0
fi

fail=0
while IFS=$'\t' read -r name bxml; do
  if band bxml raw "$bxml" >/dev/null 2>&1; then
    echo "✓ $name — well-formed BXML"
  else
    echo "✗ $name — band rejected:" >&2
    echo "    $bxml" >&2
    fail=1
  fi
done < <(npx --yes tsx scripts/emit-bxml.ts)

exit $fail
