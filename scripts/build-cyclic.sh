#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROSETTATAB_WITH_RELAX=ON bash scripts/build-engine.sh configure
for mode in ${ROSETTATAB_BUILD_MODE:-native wasm}; do
  if [ "$mode" != native ] && [ "$mode" != wasm ]; then
    echo 'Choose native or wasm.' >&2; exit 1
  fi
  cmake -S engine -B "engine/artifacts/$mode" -DROSETTATAB_CYCLIC_APPLICATION=ON
  cmake --build "engine/artifacts/$mode" --target rosettatab-cyclic -j "${ROSETTATAB_JOBS:-3}"
done
