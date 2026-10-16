#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pin=369e400415dd5c585f80dcf7b647147ee520e8ba
mkdir -p .vendor
if [ ! -d .vendor/rosetta/.git ]; then
  git clone --filter=blob:none --no-checkout https://github.com/RosettaCommons/rosetta.git .vendor/rosetta
  git -C .vendor/rosetta sparse-checkout init --cone
  git -C .vendor/rosetta sparse-checkout set source database
fi
git -C .vendor/rosetta checkout "$pin"
python3 - <<'PY'
import subprocess
root='.vendor/rosetta'
rows=subprocess.check_output(['git','-C',root,'config','--file','.gitmodules','--get-regexp','path'],text=True).splitlines()
paths=[r.split(' ',1)[1] for r in rows if 'boost_submod/' in r or any(x in r for x in ['mmtf-cpp','msgpack-c.upstream','rdkit.upstream','c-cmaes/c-cmaes','gemmi_repo'])]
subprocess.run(['git','-C',root,'submodule','update','--init','--depth','1','--jobs','4','--',*paths],check=True)
PY
if [ ! -d .vendor/emsdk/.git ]; then git clone --depth 1 https://github.com/emscripten-core/emsdk.git .vendor/emsdk; fi
.vendor/emsdk/emsdk install 6.0.11
.vendor/emsdk/emsdk activate 6.0.11
