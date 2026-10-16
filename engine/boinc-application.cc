// Research runner for the pinned upstream BOINC application's scientific dispatch.
// The native BOINC transport, process supervisor and graphics shared memory are
// intentionally replaced by the browser worker host. This is not BOINC identity.
#include <core/pose/Pose.hh>
#include <core/pack/rotamer_set/FixbbRotamerSets.hh>
#include <ObjexxFCL/FArray1D.hh>
#include <sstream>
#include <string>
#include <vector>
#include <stdexcept>
#ifndef __EMSCRIPTEN__
#include <core/init/init.hh>
#include <core/conformation/Residue.hh>
#include <core/io/silent/SilentFileData.hh>
#include <core/io/silent/SilentFileOptions.hh>
#include <core/io/silent/SilentStruct.hh>
#include <core/scoring/ScoreFunction.hh>
#include <core/scoring/ScoreFunctionFactory.hh>
#include <utility/vector1.hh>
#include <iostream>
#include <iomanip>
#endif
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
static double quantum_started=0;
extern "C" void rosettatab_yield() {
  if(!quantum_started)return;
  const double elapsed=emscripten_get_now()-quantum_started;
  if(elapsed<12)return;
  emscripten_sleep(static_cast<int>(elapsed*3)+1);
  quantum_started=emscripten_get_now();
}
// Raw application scores can use different objectives and chemical types. Do
// not present them as REF2015 live frames until a protocol-specific bridge passes.
extern "C" void rosettatab_relax_snapshot(core::pose::Pose const&,double) {}
extern "C" void rosettatab_minimizer_snapshot(core::pose::Pose const&) {rosettatab_yield();}
extern "C" void rosettatab_pack_begin(core::pose::Pose const*) {}
extern "C" void rosettatab_pack_snapshot(core::pack::rotamer_set::FixbbRotamerSets const&,ObjexxFCL::FArray1D_int const&) {rosettatab_yield();}
#endif
int rosettatab_boinc_main(int,char**);
// Called once per fresh worker: Rosetta's global option system is process-wide.
// Arguments use newline framing, not a shell. The research host supplies files
// in MEMFS; the volunteer server never supplies executable modules or scripts.
extern "C" int rosettatab_run_application(const char* arguments) {
  if(!arguments)return 2;
  std::vector<std::string> strings{"minirosetta"};
  std::istringstream lines(arguments);std::string argument;
  while(std::getline(lines,argument)) {
    if(argument.find('\r')!=std::string::npos || argument.find('\0')!=std::string::npos)return 2;
    strings.push_back(argument);
  }
  std::vector<char*> argv;
  for(auto& value:strings)argv.push_back(&value[0]);
  argv.push_back(nullptr);
#ifdef __EMSCRIPTEN__
  quantum_started=emscripten_get_now();
#endif
  return rosettatab_boinc_main(static_cast<int>(strings.size()),argv.data());
}
int main(int argc,char** argv) {
#ifdef __EMSCRIPTEN__
  return 0;
#else
  if(argc==4 && std::string(argv[1])=="--rescore-silent") {
    // Preserve cyclic bonds, D residues and other annotated chemistry from the
    // silent record. A linear-PDB rescore would test a different molecule.
    core::init::init(utility::vector1<std::string>{"rescore","-database",argv[3],"-mute","all",
      "-in:file:no_binary_dunlib","true","-out:file:dont_rewrite_dunbrack_database","true"});
    core::io::silent::SilentFileOptions options;
    core::io::silent::SilentFileData data(options);data.read_file(argv[2]);
    auto score=core::scoring::ScoreFunctionFactory::create_score_function("ref2015");
    for(auto it=data.begin();it!=data.end();++it) {
      core::pose::Pose pose;it->fill_pose(pose);
      const bool cyclic=pose.size()>1 && pose.residue(1).connected_residue_at_lower()==pose.size()
        && pose.residue(pose.size()).connected_residue_at_upper()==1;
      const double closure_distance=pose.residue(1).xyz("N").distance(pose.residue(pose.size()).xyz("C"));
      int d_residues=0;
      for(core::Size i=1;i<=pose.size();++i)if(pose.residue(i).type().is_d_aa())++d_residues;
      std::cout<<std::setprecision(17)<<"ROSETTATAB_SILENT_SCORE "<<it->decoy_tag()<<" "
        <<it->get_energy("score")<<" "<<(*score)(pose)<<" "<<pose.size()<<" "<<cyclic<<" "<<closure_distance<<" "<<d_residues<<std::endl;
    }
    return 0;
  }
  return rosettatab_boinc_main(argc,argv);
#endif
}
