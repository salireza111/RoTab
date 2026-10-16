#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Reuse the pinned, fully compiled protocol libraries. The separate target keeps
# unvalidated application dispatch out of the volunteer extension package.
ROSETTATAB_WITH_RELAX=ON bash scripts/build-engine.sh configure
cmake -S engine -B engine/artifacts/native -DROSETTATAB_BOINC_APPLICATION=ON
source .vendor/emsdk/emsdk_env.sh >/dev/null
emcmake cmake -S engine -B engine/artifacts/wasm -DROSETTATAB_BOINC_APPLICATION=ON
for mode in ${ROSETTATAB_BUILD_MODE:-native wasm}; do
  if [ "$mode" != native ] && [ "$mode" != wasm ]; then
    echo 'Choose native or wasm.' >&2; exit 1
  fi
  cmake --build "engine/artifacts/$mode" --target rosettatab-application -j "${ROSETTATAB_JOBS:-3}"
done
