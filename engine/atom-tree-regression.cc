// Developer regression for WASM-only stack adaptations, with real Rosetta trees.
#include <core/init/init.hh>
#include <core/import_pose/import_pose.hh>
#include <core/pose/Pose.hh>
#include <core/conformation/Conformation.hh>
#include <core/conformation/Residue.hh>
#include <core/kinematics/AtomTree.hh>
#include <core/kinematics/tree/Atom.hh>
#include <utility/vector1.hh>
#include <ObjexxFCL/FArray1D.hh>
#include <random>
#include <vector>
#include <stdexcept>
#include <iostream>

using namespace core;
using kinematics::tree::Atom;
using kinematics::tree::AtomCOP;

// Original pinned upstream recursive traversal, independent of the new worklist.
static void reference(Atom const& atom, int& current, int& biggest,
    kinematics::DomainMap& domains, id::AtomID_Mask const& dof,
    id::AtomID_Mask const& xyz) {
  int color=current;
  const bool moved=dof[atom.id()], position=xyz[atom.id()];
  if(moved) {
    ++biggest;
    if(!atom.is_jump()) {current=biggest;++biggest;}
    color=biggest;
  }
  const int previous=domains(atom.id().rsd());
  if(!moved && position) domains(atom.id().rsd())=0;
  else if(previous<0) domains(atom.id().rsd())=color;
  else if(previous==0 || previous==color) {}
  else domains(atom.id().rsd())=0;
  for(auto it=atom.atoms_begin();it!=atom.atoms_end();++it)
    reference(**it,color,biggest,domains,dof,xyz);
}

static std::vector<AtomCOP> nodes(AtomCOP root) {
  std::vector<AtomCOP> all{root};
  for(Size i=0;i<all.size();++i)
    for(auto it=all[i]->atoms_begin();it!=all[i]->atoms_end();++it)all.push_back(*it);
  return all;
}

int main(int argc,char** argv) {
  if(argc!=3)throw std::runtime_error("Pass database and PDB paths.");
  utility::vector1<std::string> options;
  for(auto const& s:std::vector<std::string>{"tree-regression","-database",argv[1],"-mute","all","-constant_seed","-in:file:no_binary_dunlib","true","-out:file:dont_rewrite_dunbrack_database","true"})options.push_back(s);
  init::init(options);
  pose::Pose pose;import_pose::pose_from_file(pose,argv[2]);
  auto root=pose.conformation().atom_tree().root();
  id::AtomID_Mask dof,xyz;dof.resize(pose.size());xyz.resize(pose.size());
  std::mt19937 random(17);
  for(int test=0;test<100;++test) {
    for(Size i=1;i<=pose.size();++i) {
      dof.resize(i,pose.residue(i).natoms());xyz.resize(i,pose.residue(i).natoms());
      for(Size j=1;j<=pose.residue(i).natoms();++j) {
        dof[id::AtomID(j,i)]=test==0 ? false : (test==1 ? true : random()%5==0);
        xyz[id::AtomID(j,i)]=test==0 ? false : (test==1 ? true : random()%3==0);
      }
    }
    kinematics::DomainMap expected(pose.size(),-1),actual(pose.size(),-1);
    int expectedCurrent=1,expectedBiggest=1,actualCurrent=1,actualBiggest=1;
    reference(*root,expectedCurrent,expectedBiggest,expected,dof,xyz);
    root->update_domain_map(actualCurrent,actualBiggest,actual,dof,xyz);
    if(expectedCurrent!=actualCurrent || expectedBiggest!=actualBiggest)
      throw std::runtime_error("Traversal color state differs from upstream.");
    for(Size i=1;i<=pose.size();++i)if(expected(i)!=actual(i))
      throw std::runtime_error("Domain map differs from upstream.");
  }
  // No externally retained node may leak after releasing the tree.
  kinematics::AtomTree tree(pose.conformation().atom_tree());
  std::vector<std::weak_ptr<Atom const>> weak;
  for(auto const& atom:nodes(tree.root()))weak.push_back(atom);
  tree.clear();
  for(auto const& atom:weak)if(!atom.expired())throw std::runtime_error("Atom release leaked a node.");
  // A retained root must preserve its entire subtree, then release it normally.
  kinematics::AtomTree shared(pose.conformation().atom_tree());
  AtomCOP held=shared.root();const Size count=nodes(held).size();
  std::weak_ptr<Atom const> retained=held;
  shared.clear();
  if(nodes(held).size()!=count)throw std::runtime_error("Retained subtree was detached.");
  held.reset();
  if(!retained.expired())throw std::runtime_error("Retained root leaked after release.");
  std::cout<<"{\"passed\":true,\"cases\":100,\"residues\":"<<pose.size()<<",\"treeAtoms\":"<<count<<",\"ownershipChecks\":true}"<<std::endl;
}
