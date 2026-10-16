// Fixed scientific family entry point, without the all-mover RosettaScripts
// release registry. The upstream cyclic application and algorithms are intact.
#include <protocols/cyclic_peptide_predict/SimpleCycpepPredictApplication.hh>
#include <core/init/init.hh>
#include <basic/options/option.hh>
#include <basic/options/keys/run.OptionKeys.gen.hh>
#include <utility/excn/Exceptions.hh>
#include <stdexcept>
#ifdef __EMSCRIPTEN__
#include <core/scoring/ScoringManager.hh>
#include <core/energy_methods/ChainbreakEnergyCreator.hh>
#include <core/energy_methods/LinearChainbreakEnergyCreator.hh>
#include <utility/pointer/memory.hh>
#endif
int rosettatab_boinc_main(int argc,char** argv) {
  try {
    protocols::cyclic_peptide_predict::SimpleCycpepPredictApplication::register_options();
    core::init::init(argc,argv);
#ifdef __EMSCRIPTEN__
    // The fixed REF2015 family omits unrelated scoring methods. Ring closure
    // additionally requires upstream chain-break energies; register them here
    // without changing the coordinate engine's proven module or its catalogue.
    auto manager=core::scoring::ScoringManager::get_instance();
    manager->factory_register(utility::pointer::make_shared<core::energy_methods::ChainbreakEnergyCreator>());
    manager->factory_register(utility::pointer::make_shared<core::energy_methods::LinearChainbreakEnergyCreator>());
#endif
    if(basic::options::option[basic::options::OptionKeys::run::protocol]()!="simple_cycpep_predict")
      throw std::runtime_error("This scientific family supports only cyclic-peptide prediction.");
    protocols::cyclic_peptide_predict::SimpleCycpepPredictApplication application;
    application.run();
    return 0;
  }catch(utility::excn::Exception const& error){error.display();return 1;}
}
