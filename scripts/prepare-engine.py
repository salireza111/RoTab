"""Prepare the pinned Rosetta source manifests and browser integration hooks."""
import pathlib, sys, subprocess, os, re
root=pathlib.Path(__file__).resolve().parent.parent
source=root/'.vendor/rosetta/source'
sha=subprocess.check_output(['git','-C',str(source.parent),'rev-parse','HEAD'],text=True).strip()
if sha!='369e400415dd5c585f80dcf7b647147ee520e8ba': raise RuntimeError('Rosetta source pin differs.')
# The fixed browser API cannot request arbitrary energy functions. Avoid forcing
# unused RNA, membrane, density and other creators into the linked WASM module.
# Registration is pruned only for WASM; native scientific reference stays complete.
# This is a packaging adaptation, not a replacement for any scientific method.
path=source/'src/core/init/init.cc'
content=path.read_text()
# Recreate guards when the supported catalogue changes. No scientific formulas change.
content=re.sub(r'#(?:ifndef __EMSCRIPTEN__|if !defined\(__EMSCRIPTEN__\) \|\| defined\(ROSETTATAB_FULL_REGISTRY\)) // ROSETTATAB_BOUNDED_REGISTRY\n([^\n]+)\n#endif',r'\1',content)
keep={line.strip() for line in (root/'engine/ref2015-creators.txt').read_text().splitlines() if line.strip() and not line.startswith('#')}
seen=set()
def bounded_registration(match):
    line=match.group(0)
    creator=match.group(1).split('::')[-1].strip()
    seen.add(creator)
    return line if creator in keep else '#if !defined(__EMSCRIPTEN__) || defined(ROSETTATAB_FULL_REGISTRY) // ROSETTATAB_BOUNDED_REGISTRY\n'+line+'\n#endif'
content=re.sub(r'^static EnergyMethodRegistrator<\s*([^>]+)>[^\n]*;',bounded_registration,content,flags=re.M)
if not keep.issubset(seen):raise RuntimeError(f'Unknown required creators: {keep-seen}')
if path.read_text()!=content:path.write_text(content)
# Diagnostic backtraces have no POSIX execinfo implementation in WebAssembly.
# Keep the upstream no-op diagnostic fallback; scientific code is unchanged.
for relative in ['src/utility/backtrace.hh','src/utility/backtrace.cc']:
    path=source/relative
    original='&& !defined(ANDROID)'
    guarded=original+' && !defined(__EMSCRIPTEN__)'
    content=path.read_text()
if guarded not in content:path.write_text(content.replace(original,guarded))
# Release an atom tree without a recursive shared_ptr destruction cascade.
# Retaining children of a last-owned atom preserves externally shared subtrees;
# no coordinates, topology links, score weights or RNG state are changed.
# Native remains the unmodified, independent reference implementation.
path=source/'src/core/kinematics/AtomTree.cc'
content=path.read_text()
if 'ROSETTATAB_ITERATIVE_ATOM_RELEASE' not in content:
    marker='AtomTree::clear()\n{\n\tatom_pointer_.clear();\n\troot_.reset();'
    assert marker in content
    replacement='''AtomTree::clear()
{
#ifdef __EMSCRIPTEN__ // ROSETTATAB_ITERATIVE_ATOM_RELEASE
\tutility::vector1< AtomOP > pending;
\tpending.push_back( std::move(root_) );
\tfor ( Size i=1; i<=atom_pointer_.size(); ++i ) {
\t\tfor ( auto & atom : atom_pointer_[i] ) pending.push_back( std::move(atom) );
\t}
\tatom_pointer_.clear();
\twhile ( !pending.empty() ) {
\t\tAtomOP atom = std::move(pending.back());
\t\tpending.pop_back();
\t\tif ( atom && atom.use_count() == 1 ) {
\t\t\tfor ( auto child=atom->atoms_begin(); child!=atom->atoms_end(); ++child ) pending.push_back( *child );
\t\t}
\t\tatom.reset();
\t}
#else
\tatom_pointer_.clear();
\troot_.reset();
#endif'''
    path.write_text(content.replace(marker,replacement,1))
# Preserve depth-first order and sibling color propagation without recursive
# VM frames. Native keeps the original function as an independent reference.
path=source/'src/core/kinematics/tree/Atom_.cc'
content=path.read_text()
if 'ROSETTATAB_ITERATIVE_DOMAIN_MAP' not in content:
    start=content.index('\n\tint color( current_color );',content.index('Atom_::update_domain_map('))
    end=content.index('\n}\n',start)
    original=content[start:end]
    iterative='''
#ifdef __EMSCRIPTEN__ // ROSETTATAB_ITERATIVE_DOMAIN_MAP
\t// Each frame holds the recursive call's local color and child cursor.
\t// A child's changed torsion updates its parent's color before the next sibling.
\tstruct Frame {
\t\tint color;
\t\tAtoms::const_iterator next, end;
\t};
\tstd::vector< Frame > pending;
\tauto enter = [&]( Atom const * atom, int & incoming_color ) {
\t\tint color = incoming_color;
\t\tbool const my_dof_moved = dof_moved[ atom->id() ];
\t\tbool const my_xyz_moved = atom_moved[ atom->id() ];
\t\tif ( my_dof_moved ) {
\t\t\t++biggest_color;
\t\t\tif ( !atom->is_jump() ) { incoming_color = biggest_color; ++biggest_color; }
\t\t\tcolor = biggest_color;
\t\t}
\t\tint const current_map = domain_map( atom->id().rsd() );
\t\tif ( !my_dof_moved && my_xyz_moved ) domain_map( atom->id().rsd() ) = 0;
\t\telse if ( current_map < 0 ) domain_map( atom->id().rsd() ) = color;
\t\telse if ( current_map != 0 && current_map != color ) domain_map( atom->id().rsd() ) = 0;
\t\tpending.push_back( Frame{ color, atom->atoms_begin(), atom->atoms_end() } );
\t};
\tenter( this, current_color );
\twhile ( !pending.empty() ) {
\t\tFrame & frame = pending.back();
\t\tif ( frame.next == frame.end ) { pending.pop_back(); continue; }
\t\tAtom const * child = (frame.next++)->get();
\t\tenter( child, frame.color );
\t}
#else'''
    path.write_text(content[:start]+iterative+original+'\n#endif'+content[end:])
# Avoid the legacy classic-Mac zlib branch; this build targets POSIX macOS.
path=source/'external/zlib-1.2.8/zutil.h'
content=path.read_text()
if '#if defined(MAC) && !defined(__APPLE__)' not in content:
    content=content.replace('#if defined(MACOS) || defined(TARGET_OS_MAC)','#if (defined(MACOS) || defined(TARGET_OS_MAC)) && !defined(__APPLE__)')
    path.write_text(content)
# Use the bundled SQLite header rather than a host-specific system installation.
path=source/'external/dbio/cppdb/sqlite3_backend.cpp'
content=path.read_text()
if '#include <sqlite3.h>' in content:path.write_text(content.replace('#include <sqlite3.h>','#include "../sqlite3/sqlite3.h"'))
# Trace successful database reads for a measured, protocol-specific package.
path=source/'src/utility/io/izstream.cc'
content=path.read_text()
if 'ROSETTATAB_DB_READ' not in content:
    content=content.replace('#include <utility/io/izstream.hh>','#include <utility/io/izstream.hh>\n#include <cstdlib>\n#include <iostream>')
    end='\n}\n\n\n} // namespace io'
    content=content.replace(end,'\n\tif (if_stream_ && std::getenv("ROSETTATAB_TRACE_DATABASE")) std::cerr << "ROSETTATAB_DB_READ " << filename_ << std::endl;'+end)
    path.write_text(content)
# Yield between score evaluations. This hook does not touch the pose or RNG.
path=source/'src/core/scoring/ScoreFunction.cc'
content=path.read_text()
if 'rosettatab_yield' not in content:
    content='#ifdef __EMSCRIPTEN__\nextern "C" void rosettatab_yield();\n#endif\n'+content
    signature='ScoreFunction::operator()( pose::Pose & pose ) const\n{'
    assert signature in content
    content=content.replace(signature,signature+'\n#ifdef __EMSCRIPTEN__\n\trosettatab_yield();\n#endif')
    path.write_text(content)
# Emit measured poses at commands in the fixed, one-repeat FastRelax protocol.
# Scoring is performed on a pose copy in the harness and never touches its RNG.
path=source/'src/protocols/relax/FastRelax.cc'
content=path.read_text()
if 'rosettatab_relax_snapshot' not in content:
    include='#include <protocols/relax/FastRelax.hh>'
    assert include in content
    content=content.replace(include,include+'\n#ifdef __EMSCRIPTEN__\nextern "C" void rosettatab_relax_snapshot(core::pose::Pose const&, double);\n#endif')
    marker='\t\tRelaxScriptCommand const & cmd = script_[ ncmd ];'
    assert marker in content
    content=content.replace(marker,'#ifdef __EMSCRIPTEN__\n\t\trosettatab_relax_snapshot(pose, static_cast<double>(ncmd) / script_.size());\n#endif\n'+marker,1)
    path.write_text(content)
# Publish actual internal minimizer states after the derivative evaluation has
# synchronized the pose with its variables (the same point used by Rosetta's
# DumpTrajectoryEnergy). Throttling and display-only rescoring live in the harness.
path=source/'src/core/optimization/AtomTreeMultifunc.cc'
content=path.read_text()
if 'rosettatab_minimizer_snapshot' not in content:
    include='#include <core/optimization/AtomTreeMultifunc.hh>'
    assert include in content
    content=content.replace(include,include+'\n#ifdef __EMSCRIPTEN__\nextern "C" void rosettatab_minimizer_snapshot(core::pose::Pose const&);\n#endif')
    marker='\tatom_tree_dfunc( pose_, min_map_, score_function_, vars, dE_dvars );'
    assert marker in content
    content=content.replace(marker,marker+'\n#ifdef __EMSCRIPTEN__\n\trosettatab_minimizer_snapshot(pose_);\n#endif',1)
    path.write_text(content)
# Cartesian minimization has a separate derivative implementation. Publish at
# its corresponding synchronized-pose point using the same display-only bridge.
path=source/'src/core/optimization/CartesianMultifunc.cc'
content=path.read_text()
if 'rosettatab_minimizer_snapshot' not in content:
    include='#include <core/optimization/CartesianMultifunc.hh>'
    assert include in content
    content=content.replace(include,include+'\n#ifdef __EMSCRIPTEN__\nextern "C" void rosettatab_minimizer_snapshot(core::pose::Pose const&);\n#endif')
    marker='\tcartesian_dfunc( pose_, min_map_, score_function_, vars, dE_dvars );'
    assert marker in content
    content=content.replace(marker,marker+'\n#ifdef __EMSCRIPTEN__\n\trosettatab_minimizer_snapshot(pose_);\n#endif',1)
    path.write_text(content)
# During fixed-backbone packing the current assignment exists in the annealer,
# not yet in the Pose. Supply its full accepted assignment to the display bridge.
path=source/'src/core/pack/pack_rotamers.cc'
content=path.read_text()
if 'rosettatab_pack_begin' not in content:
    marker='\tannealer->run();'
    assert marker in content
    include='#include <core/pack/pack_rotamers.hh>'
    assert include in content
    content=content.replace(include,include+'\n#ifdef __EMSCRIPTEN__\nextern "C" void rosettatab_pack_begin(core::pose::Pose const*);\n#endif')
    content=content.replace(marker,'#ifdef __EMSCRIPTEN__\n\trosettatab_pack_begin(&pose);\n#endif\n'+marker+'\n#ifdef __EMSCRIPTEN__\n\trosettatab_pack_begin(nullptr);\n#endif',1)
    path.write_text(content)
path=source/'src/core/pack/annealer/FixbbSimAnnealer.cc'
content=path.read_text()
if 'rosettatab_pack_snapshot' not in content:
    marker='static basic::Tracer TR('
    assert marker in content
    content=content.replace(marker,'#ifdef __EMSCRIPTEN__\nextern "C" void rosettatab_pack_snapshot(core::pack::rotamer_set::FixbbRotamerSets const&, ObjexxFCL::FArray1D_int const&);\n#endif\n\n'+marker,1)
    marker='\t\t\t\tstate_on_node(moltenres_id) = rotamer_state_on_moltenres;'
    assert marker in content
    content=content.replace(marker,marker+'\n#ifdef __EMSCRIPTEN__\n\t\t\t\trosettatab_pack_snapshot(*rotamer_sets(),state_on_node);\n#endif',1)
    path.write_text(content)
# Merge upstream's split Boost headers portably (upstream shell script uses GNU ln -T).
boost=source/'external/boost_submod/boost';boost.mkdir(exist_ok=True)
for base in (source/'external/boost_submod').glob('*/include/boost'):
    for path in base.rglob('*'):
        relative=path.relative_to(base);dest=boost/relative
        if path.is_dir():dest.mkdir(parents=True,exist_ok=True)
        elif not dest.exists():dest.symlink_to(os.path.relpath(path,dest.parent))
for script in ['version.py']:
    subprocess.run([sys.executable,script],cwd=source,check=True)
for script in ['update_options.sh','update_ResidueType_enum_files.sh']:
    subprocess.run(['bash',script],cwd=source,check=True)
projects={};exec((source/'projects.settings').read_text(),projects)
relax='--relax' in sys.argv
files=[]
for project in projects['projects']['src']:
    if project in ['devel','apps','pilot_apps'] or project.startswith('protocols') and not relax:continue
    ns={};exec((source/'src'/f'{project}.src.settings').read_text(),ns)
    for directory,names in ns['sources'].items():
        for name in names:
            # Upstream's CPU builds exclude CUDA translation units.
            if name.endswith('.cu'):continue
            path=source/'src'/directory/name
            found=next((pathlib.Path(str(path)+ext) for ext in ['.cc','.c'] if pathlib.Path(str(path)+ext).exists()),None)
            if not found:raise RuntimeError(f'Missing source: {path}')
            files.append(found)
external=[]
for library in ['rdkit','libxml2']:
    ns={};exec((source/'external'/f'{library}.external.settings').read_text(),ns)
    for directory,names in ns['sources'].items():
        for name in names:
            path=source/'external'/directory/name
            if not path.exists(): raise RuntimeError(f'Missing external source: {path}')
            external.append(path)
external.extend((source/'external/dbio/cppdb').glob('*.cpp'))
external=[p for p in external if p.name not in ['mysql_backend.cpp','postgres_backend.cpp','postgresql_backend.cpp','odbc_backend.cpp','test.cpp']]
external.append(source/'external/dbio/sqlite3/sqlite3.c')
external.append(source/'external/c-cmaes/c-cmaes/src/cmaes.c')
external.extend((source/'external/zlib-1.2.8').glob('*.c'))
out=pathlib.Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
def cmake_list(name,paths):return f'set({name}\n'+''.join(f'  "{p}"\n' for p in paths)+')\n'
(out/'sources.cmake').write_text(cmake_list('ROSETTA_CORE_SOURCES',files)+cmake_list('ROSETTA_EXTERNAL_SOURCES',external))
print(f'{len(files)} scientific sources; {len(external)} external sources; relaxation={relax}')
