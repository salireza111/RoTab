"""Create a candidate database from actual read traces. Native rescoring must verify its coverage."""
import argparse,pathlib,shutil,json,hashlib
p=argparse.ArgumentParser();p.add_argument('trace');p.add_argument('--database',default='.vendor/rosetta/database');p.add_argument('--output',default='engine/artifacts/database');a=p.parse_args()
source=pathlib.Path(a.database).resolve();output=pathlib.Path(a.output).resolve();files=set()
for line in pathlib.Path(a.trace).read_text(errors='replace').splitlines():
    if 'ROSETTATAB_DB_READ ' not in line:continue
    name=line.split('ROSETTATAB_DB_READ ',1)[1].strip();candidate=pathlib.Path(name).resolve()
    if candidate.is_relative_to(source) and candidate.is_file():files.add(candidate.relative_to(source))
if not files:raise SystemExit('No successful database reads found. Run the real native harness with ROSETTATAB_TRACE_DATABASE=1 first.')
output.mkdir(parents=True,exist_ok=True);records=[]
for relative in sorted(files):
    path=source/relative;dest=output/relative;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,dest)
    records.append({'path':str(relative),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
manifest={'sourceSha':'369e400415dd5c585f80dcf7b647147ee520e8ba','coverage':'candidate: traced inputs/protocols only','bytes':sum(f['bytes'] for f in records),'files':records}
(output.parent/'database-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Candidate database: {len(records)} files, {manifest["bytes"]:,} bytes. Verify it with real native/WASM calculations before packaging.')
