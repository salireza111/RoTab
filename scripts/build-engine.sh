#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
action=${1:-build}
mkdir -p engine/artifacts .local
for mode in native wasm; do
  if [ "${ROSETTATAB_WITH_RELAX:-OFF}" = ON ]; then
    python3 scripts/prepare-engine.py "engine/artifacts/$mode" --relax
  else
    python3 scripts/prepare-engine.py "engine/artifacts/$mode"
  fi
done
cmake -S engine -B engine/artifacts/native -DROSETTA_SOURCE="$PWD/.vendor/rosetta/source" -DROSETTATAB_RELAX="${ROSETTATAB_WITH_RELAX:-OFF}"
source .vendor/emsdk/emsdk_env.sh >/dev/null
wasm_database=${ROSETTATAB_DATABASE:-"$PWD/engine/artifacts/database"}
if [ ! -d "$wasm_database" ]; then wasm_database="$PWD/.vendor/rosetta/database"; fi
emcmake cmake -S engine -B engine/artifacts/wasm -DROSETTA_SOURCE="$PWD/.vendor/rosetta/source" -DROSETTATAB_RELAX="${ROSETTATAB_WITH_RELAX:-OFF}" -DROSETTA_DATABASE="$wasm_database" -DROSETTATAB_ASYNCIFY="${ROSETTATAB_ASYNCIFY:-ON}"
if [ "$action" != configure ]; then
  for mode in ${ROSETTATAB_BUILD_MODE:-native wasm}; do
    if [ "$mode" != native ] && [ "$mode" != wasm ]; then echo 'Choose native or wasm.' >&2; exit 1; fi
    cmake --build "engine/artifacts/$mode" -j "${ROSETTATAB_JOBS:-3}"
  done
fi
