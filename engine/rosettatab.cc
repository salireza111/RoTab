// Private Rosetta adapter. Scientific algorithms remain in the pinned upstream sources.
// Rosetta use and redistribution are governed by its license, not this project's application license.
#include <core/init/init.hh>
#include <core/import_pose/import_pose.hh>
#include <core/pose/Pose.hh>
#include <core/scoring/ScoreFunction.hh>
#include <core/scoring/ScoreFunctionFactory.hh>
#include <core/scoring/Energies.hh>
#include <core/pack/rotamer_set/FixbbRotamerSets.hh>
#include <core/conformation/Residue.hh>
#include <ObjexxFCL/FArray1D.hh>
#include <numeric/random/random.hh>
#include <core/kinematics/MoveMap.hh>
#include <core/pack/task/TaskFactory.hh>
#include <core/pack/task/PackerTask.hh>
#include <core/scoring/ScoreType.hh>
#include <utility/vector1.hh>
#ifdef ROSETTATAB_RELAX
#include <protocols/relax/FastRelax.hh>
#include <protocols/minimization_packing/MinMover.hh>
#include <protocols/minimization_packing/PackRotamersMover.hh>
#include <protocols/denovo_design/movers/FastDesign.hh>
#endif
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(void, emit_snapshot, (const char* pdb, double energy, double progress, const char* source, int sequence, int iteration), {
  if (globalThis.rosettatabSnapshot) globalThis.rosettatabSnapshot(UTF8ToString(pdb),energy,progress,UTF8ToString(source),sequence,iteration);
});
#else
static void emit_snapshot(const char*,double,double,const char*,int,int) {}
#endif
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <algorithm>
#include <vector>

static std::string database_path="/database";
static bool initialized=false;
static std::string response;
static int snapshot_sequence=0;
#ifdef __EMSCRIPTEN__
static core::scoring::ScoreFunctionOP display_score;
static core::pose::Pose const* packing_pose=nullptr;
static double display_progress=0, last_snapshot_at=0;
static int minimizer_evaluations=0, packing_moves=0;
static bool emitting_snapshot=false;
static double quantum_started=0, active_ms=0, sleeping_ms=0;
static int duty_percent=25, yields=0;
extern "C" void rosettatab_yield() {
  if (!quantum_started) return;
  const double work=emscripten_get_now()-quantum_started;
  if(work<12)return;
  active_ms+=work;
  const int wait=std::max(1,static_cast<int>(work*(100.0/duty_percent-1)));
  const double before=emscripten_get_now();emscripten_sleep(wait);
  sleeping_ms+=emscripten_get_now()-before;quantum_started=emscripten_get_now();yields++;
}
static bool snapshot_due() {
  return display_score && !emitting_snapshot && emscripten_get_now()-last_snapshot_at>=200;
}
// Rescore a COPY with the unmodified ref2015 weights. FastRelax's ramped
// objective is intentionally not mixed into the displayed energy history.
static void display_snapshot(core::pose::Pose const& pose, const char* source, int iteration) {
  if(!display_score || emitting_snapshot)return;
  emitting_snapshot=true;
  core::pose::Pose copy(pose);
  // A minimizer Pose retains its neighbor-list/minimization graph. These are
  // unsuitable for independent full-weight scoring or PDB energy tables.
  if(copy.energies().use_nblist())copy.energies().reset_nblist();
  copy.energies().clear();
  const double energy=(*display_score)(copy);
  std::ostringstream pdb;copy.dump_pdb(pdb);
  emit_snapshot(pdb.str().c_str(),energy,display_progress,source,++snapshot_sequence,iteration);
  last_snapshot_at=emscripten_get_now();
  emitting_snapshot=false;
}
extern "C" void rosettatab_relax_snapshot(core::pose::Pose const& pose, double progress) {
  display_progress=std::max(display_progress,progress);
  display_snapshot(pose,"stage",0);
}
extern "C" void rosettatab_minimizer_snapshot(core::pose::Pose const& pose) {
  ++minimizer_evaluations;
  rosettatab_yield();
  if(snapshot_due())display_snapshot(pose,"minimizing",minimizer_evaluations);
}
extern "C" void rosettatab_pack_begin(core::pose::Pose const* pose) {
  packing_pose=pose;
}
extern "C" void rosettatab_pack_snapshot(core::pack::rotamer_set::FixbbRotamerSets const& rotamers, ObjexxFCL::FArray1D_int const& states) {
  // The annealer has not written its current rotamers to the original pose.
  // Reconstruct a complete accepted assignment on a display-only copy.
  ++packing_moves;
  if(!packing_pose || packing_moves%32)return;
  rosettatab_yield();
  if(!snapshot_due())return;
  for(core::Size i=1;i<=rotamers.nmoltenres();++i)if(states(i)<=0)return;
  core::pose::Pose copy(*packing_pose);
  for(core::Size i=1;i<=rotamers.nmoltenres();++i)
    copy.replace_residue(rotamers.moltenres_2_resid(i),*rotamers.rotamer_for_moltenres(i,states(i)),false);
  display_snapshot(copy,"packing",packing_moves);
}
#endif
static std::string quote(const std::string& s) {
  std::ostringstream out;out<<'"';
  for(unsigned char c:s) {if(c=='"'||c=='\\')out<<'\\'<<c;else if(c=='\n')out<<"\\n";else if(c=='\r')out<<"\\r";else if(c=='\t')out<<"\\t";else if(c>=32)out<<c;}
  out<<'"';return out.str();
}
static void initialize(int seed) {
  if(initialized)return;
  utility::vector1<std::string> options;
  for(const auto& s:std::vector<std::string>{"rosettatab","-database",database_path,"-constant_seed","-jran",std::to_string(seed),"-mute","all","-ignore_unrecognized_res","false","-in:file:no_binary_dunlib","true","-out:file:dont_rewrite_dunbrack_database","true"})options.push_back(s);
  core::init::init(options);initialized=true;
}
static bool supported_protocol(std::string const& protocol) {
  return protocol=="score" || protocol=="relax" || protocol=="minimize" ||
    protocol=="repack" || protocol=="fixed_backbone_design" || protocol=="fastdesign" ||
    protocol=="cartesian_minimize" || protocol=="cartesian_relax";
}
extern "C" const char* rosettatab_run_protocol(const char* input,const char* requested_protocol,int seed,int duty) {
  try {
    const std::string protocol=requested_protocol ? requested_protocol : "";
    if(!supported_protocol(protocol))throw std::runtime_error("Unsupported packaged Rosetta protocol: "+protocol);
    if(!input || seed<1 || seed>2000000000)throw std::runtime_error("Invalid scientific input or seed.");
    initialize(seed);numeric::random::rg().set_seed(seed);
    snapshot_sequence=0;
#ifdef __EMSCRIPTEN__
    duty_percent=std::max(10,std::min(75,duty));active_ms=0;sleeping_ms=0;yields=0;quantum_started=emscripten_get_now();
    display_progress=0;last_snapshot_at=0;minimizer_evaluations=0;packing_moves=0;packing_pose=nullptr;emitting_snapshot=false;
#endif
    core::pose::Pose pose;core::import_pose::pose_from_pdbstring(pose,std::string(input));
    if(pose.size()<1||pose.num_chains()!=1)throw std::runtime_error("A nonempty single protein chain is required.");
    auto score=core::scoring::ScoreFunctionFactory::create_score_function("ref2015");
#ifdef __EMSCRIPTEN__
    display_score=score->clone();
#endif
    double energy=(*score)(pose);std::ostringstream start;pose.dump_pdb(start);emit_snapshot(start.str().c_str(),energy,0,"initial",++snapshot_sequence,0);
#ifdef __EMSCRIPTEN__
    emscripten_sleep(1);
#endif
    auto objective=score->clone();
    const bool cartesian=protocol=="cartesian_minimize" || protocol=="cartesian_relax";
    if(cartesian) {
      objective->set_weight(core::scoring::cart_bonded,0.5);
      objective->set_weight(core::scoring::pro_close,0.0);
    }
    if(protocol!="score") {
#ifdef ROSETTATAB_RELAX
      if(protocol=="relax" || protocol=="cartesian_relax") {
        protocols::relax::FastRelax mover(objective,1);
        if(cartesian){mover.cartesian(true);mover.max_iter(200);}
        mover.apply(pose);
      } else if(protocol=="minimize" || protocol=="cartesian_minimize") {
        auto movemap=utility::pointer::make_shared<core::kinematics::MoveMap>();
        movemap->set_bb(true);movemap->set_chi(true);movemap->set_jump(false);
        protocols::minimization_packing::MinMover mover(movemap,objective,"lbfgs_armijo_nonmonotone",0.01,true);
        mover.max_iter(200);mover.cartesian(cartesian);mover.apply(pose);
      } else if(protocol=="repack" || protocol=="fixed_backbone_design") {
        auto task=core::pack::task::TaskFactory::create_packer_task(pose);
        task->or_include_current(true);
        if(protocol=="repack")task->restrict_to_repacking();
        protocols::minimization_packing::PackRotamersMover mover(objective,task,1);
        mover.apply(pose);
      } else if(protocol=="fastdesign") {
        protocols::denovo_design::movers::FastDesign mover(objective,1);
        mover.set_up_default_task_factory();mover.apply(pose);
      }
#else
      throw std::runtime_error("Scientific protocol libraries have not been built.");
#endif
    }
    const double objective_energy=(*objective)(pose);
    // All live frames and returned PDB energy tables use the common REF2015
    // reporting function, even when Cartesian optimization adds cart_bonded.
    (*score)(pose);
    std::ostringstream pdb;pose.dump_pdb(pdb);
    // Report the score of the returned PDB coordinates, including PDB rounding.
    core::pose::Pose returned;core::import_pose::pose_from_pdbstring(returned,pdb.str());energy=(*score)(returned);
    emit_snapshot(pdb.str().c_str(),energy,1,"final",++snapshot_sequence,0);
    std::ostringstream out;out<<std::setprecision(17)<<"{\"energy\":"<<energy<<",\"pdb\":"<<quote(pdb.str())
      <<",\"protocol\":"<<quote(protocol)<<",\"scoreFunction\":\"ref2015\",\"sequence\":"<<quote(pose.sequence())
      <<",\"objectiveEnergy\":"<<objective_energy<<",\"objectiveScoreFunction\":"<<quote(cartesian?"ref2015_cart":"ref2015");
#ifdef __EMSCRIPTEN__
    rosettatab_yield();out<<",\"activeMs\":"<<active_ms<<",\"sleepingMs\":"<<sleeping_ms<<",\"yields\":"<<yields<<",\"liveSnapshots\":"<<snapshot_sequence<<",\"minimizerEvaluations\":"<<minimizer_evaluations<<",\"packingMoves\":"<<packing_moves;quantum_started=0;display_score.reset();packing_pose=nullptr;
#endif
    out<<"}";response=out.str();
  } catch(const std::exception& e) {
#ifdef __EMSCRIPTEN__
    display_score.reset();packing_pose=nullptr;emitting_snapshot=false;quantum_started=0;
#endif
    response="{\"error\":"+quote(e.what())+"}";
  }
  return response.c_str();
}
// Retain the original ABI for saved pilot clients and scientific regression proofs.
extern "C" const char* rosettatab_run(const char* input,int relax,int seed,int duty) {
  return rosettatab_run_protocol(input,relax?"relax":"score",seed,duty);
}
int main(int argc,char** argv) {
#ifdef __EMSCRIPTEN__
  return 0;
#else
  std::string input,output,protocol="score";int seed=1;
  for(int i=1;i<argc;i++) {
    std::string key=argv[i];if(i+1>=argc)throw std::runtime_error("Missing argument value.");std::string value=argv[++i];
    if(key=="--input")input=value;else if(key=="--database")database_path=value;else if(key=="--protocol")protocol=value;
    else if(key=="--seed")seed=std::stoi(value);else if(key=="--output")output=value;else throw std::runtime_error("Unknown argument.");
  }
  if(input.empty()||!supported_protocol(protocol)){std::cerr<<"Use --input file.pdb --database path --protocol <packaged protocol> --seed N\n";return 2;}
  std::ifstream file(input);if(!file){std::cerr<<"Input unavailable\n";return 2;}std::stringstream pdb;pdb<<file.rdbuf();
  std::cout<<"ROSETTATAB_RESULT "<<rosettatab_run_protocol(pdb.str().c_str(),protocol.c_str(),seed,25)<<std::endl;
  return response.find("\"error\"")==std::string::npos?0:1;
#endif
}
