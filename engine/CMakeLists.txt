cmake_minimum_required(VERSION 3.20)
project(RosettaTabEngine LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
option(ROSETTATAB_RELAX "Build full protocol libraries for FastRelax" OFF)
option(ROSETTATAB_ASYNCIFY "Use portable Asyncify instead of experimental JSPI" ON)
option(ROSETTATAB_BOINC_APPLICATION "Build experimental full upstream scientific application" OFF)
option(ROSETTATAB_CYCLIC_APPLICATION "Build experimental fixed cyclic-peptide family" OFF)
if(NOT ROSETTA_SOURCE)
  message(FATAL_ERROR "Pass -DROSETTA_SOURCE=/path/to/pinned/rosetta/source")
endif()

include_directories(${ROSETTA_SOURCE}/src ${ROSETTA_SOURCE}/external ${ROSETTA_SOURCE}/external/include
  ${ROSETTA_SOURCE}/external/boost_submod ${ROSETTA_SOURCE}/external/dbio
  ${ROSETTA_SOURCE}/external/libxml2/include ${ROSETTA_SOURCE}/external/rdkit)
if(EMSCRIPTEN)
  if(NOT ROSETTA_DATABASE)
    set(ROSETTA_DATABASE "${ROSETTA_SOURCE}/../database")
  endif()
  add_compile_options(-fexceptions)
  include_directories(${ROSETTA_SOURCE}/src/platform/linux)
  add_compile_definitions(LINUX)
elseif(APPLE)
  include_directories(${ROSETTA_SOURCE}/src/platform/macos)
  add_compile_definitions(MAC)
else()
  include_directories(${ROSETTA_SOURCE}/src/platform/linux)
  add_compile_definitions(LINUX)
endif()
add_compile_definitions(PTR_STD CXX11 CXX14_OR_LATER CXX17 CXX17_OR_LATER UNUSUAL_ALLOCATOR_DECLARATION _LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION BOOST_ERROR_CODE_HEADER_ONLY BOOST_SYSTEM_NO_DEPRECATED BOOST_DISABLE_THREADS
  CPPDB_DISABLE_SHARED_OBJECT_LOADING CPPDB_DISABLE_THREAD_SAFETY CPPDB_WITH_SQLITE3 CPPDB_EXPORTS
  CPPDB_MAJOR=0 CPPDB_MINOR=3 CPPDB_PATCH=0 CPPDB_VERSION="0.3.0" CPPDB_SOVERSION="0"
  CPPDB_LIBRARY_PREFIX="lib" CPPDB_LIBRARY_SUFFIX=".a" SQLITE_OMIT_LOAD_EXTENSION SQLITE_THREADSAFE=0)
if(NOT MSVC)
  add_compile_options(-O1 -Wno-deprecated-declarations -Wno-deprecated-builtins)
endif()
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wno-missing-template-arg-list-after-template-kw)
endif()
include(${CMAKE_CURRENT_BINARY_DIR}/sources.cmake)
add_library(rosetta_core STATIC ${ROSETTA_CORE_SOURCES})
add_library(rosetta_external STATIC ${ROSETTA_EXTERNAL_SOURCES})
set_source_files_properties(${ROSETTA_SOURCE}/external/libxml2/trio.c PROPERTIES COMPILE_OPTIONS "-include;unistd.h")
file(GLOB ZLIB_SOURCES ${ROSETTA_SOURCE}/external/zlib-1.2.8/*.c)
set_source_files_properties(${ZLIB_SOURCES} PROPERTIES COMPILE_OPTIONS "-include;unistd.h")
add_executable(rosettatab-native rosettatab.cc)
target_link_libraries(rosettatab-native PRIVATE rosetta_core rosetta_external)
if(ROSETTATAB_RELAX)
  target_compile_definitions(rosettatab-native PRIVATE ROSETTATAB_RELAX)
endif()
if(EMSCRIPTEN)
  set_target_properties(rosettatab-native PROPERTIES OUTPUT_NAME rosetta SUFFIX .mjs)
  # -O1 coalesces locals for VM limits without -O2's pathological global inlining.
  target_link_options(rosettatab-native PRIVATE -O1 --emit-symbol-map -fexceptions -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=536870912 -sINITIAL_MEMORY=134217728
    -sSTACK_SIZE=1048576 -sASSERTIONS=1
    "-sEXPORTED_FUNCTIONS=['_rosettatab_run','_rosettatab_run_protocol','_main']" "-sEXPORTED_RUNTIME_METHODS=['ccall','FS','HEAPU8']"
    --preload-file "${ROSETTA_DATABASE}@/database")
  if(ROSETTATAB_ASYNCIFY)
    target_link_options(rosettatab-native PRIVATE -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=1048576)
    # Static constructors/options registration run synchronously, before the harness
    # enables its score-evaluation yield hook. They cannot suspend. Instrumenting
    # their enormous generated functions causes pathological browser compiler
    # allocations. Keep them synchronous; scientific execution remains Asyncify.
    # Generated enum dictionaries, residue-file parsing and energy-table setup
    # are synchronous and cannot call the ScoreFunction yield hook. Leaving
    # these large routines instrumented creates extreme VM compiler allocations,
    # especially when interrupted workers are restarted. Their scientific
    # contents are unchanged. Retain instrumentation on scoring/protocol callers.
    # Atom-tree coordinate/domain-map traversal and destruction are synchronous:
    # they never call the scientific yield/snapshot hooks. Asyncify otherwise
    # inflates every recursive frame and exhausts V8's call stack for large
    # proteins, even when the linear heap has ample space. Keep upstream tree
    # algorithms unchanged and exclude only this non-suspending namespace.
    # The pure-algebra DerivativeFinder has no yield/I/O call. Unused RNA/beta
    # initialization otherwise exceeds V8's local-variable limit.
    target_link_options(rosettatab-native PRIVATE "-sASYNCIFY_REMOVE=['_GLOBAL__sub_I_*','add_rosetta_options_*','basic::options::initialize*','core::init::*','core::kinematics::tree::*','core::chemical::generate_variant_to_string_vector*','core::chemical::generate_property_to_string_vector*','core::chemical::read_topology_file*','core::scoring::ScoreTypeManager::setup_score_type_names*','core::scoring::hbonds::HBondDatabase::initialize*','core::scoring::hbonds::HBondTypeManager::setup_type_names*','core::scoring::etable::Etable::make_pairenergy_table*','core::scoring::etable::Etable::smooth_etables_one_pair*','core::scoring::rna::chemical_shift::RNA_CS_residue_parameters::RNA_CS_residue_parameters*','core::scoring::lkball::DerivativeFinder::DerivativeFinder*']")
  else()
    target_link_options(rosettatab-native PRIVATE -sJSPI=1 "-sJSPI_EXPORTS=['rosettatab_run','rosettatab_run_protocol']")
  endif()
else()
  find_package(Threads REQUIRED)
  target_link_libraries(rosettatab-native PRIVATE Threads::Threads ${CMAKE_DL_LIBS})
endif()


if(ROSETTATAB_BOINC_APPLICATION)
  if(NOT ROSETTATAB_RELAX)
    message(FATAL_ERROR "The BOINC scientific application requires all protocol libraries.")
  endif()
  set(BOINC_APPLICATION_SOURCE ${ROSETTA_SOURCE}/src/apps/public/boinc/minirosetta.cc)
  set_source_files_properties(${BOINC_APPLICATION_SOURCE} PROPERTIES COMPILE_DEFINITIONS "main=rosettatab_boinc_main")
  add_executable(rosettatab-application EXCLUDE_FROM_ALL boinc-application.cc
    ${BOINC_APPLICATION_SOURCE} ${ROSETTA_SOURCE}/src/devel/init.release.cc
    ${ROSETTA_SOURCE}/src/core/init/init.cc)
  target_compile_definitions(rosettatab-application PRIVATE ROSETTATAB_FULL_REGISTRY)
  target_link_libraries(rosettatab-application PRIVATE rosetta_core rosetta_external)
  if(EMSCRIPTEN)
    set_target_properties(rosettatab-application PROPERTIES OUTPUT_NAME rosetta-application SUFFIX .mjs)
    get_target_property(APPLICATION_LINK_OPTIONS rosettatab-native LINK_OPTIONS)
    list(FILTER APPLICATION_LINK_OPTIONS EXCLUDE REGEX "EXPORTED_FUNCTIONS|JSPI_EXPORTS")
    target_link_options(rosettatab-application PRIVATE ${APPLICATION_LINK_OPTIONS}
      "-sEXPORTED_FUNCTIONS=['_rosettatab_run_application','_main']")
    if(NOT ROSETTATAB_ASYNCIFY)
      target_link_options(rosettatab-application PRIVATE "-sJSPI_EXPORTS=['rosettatab_run_application']")
    endif()
  else()
    target_link_libraries(rosettatab-application PRIVATE Threads::Threads ${CMAKE_DL_LIBS})
  endif()
endif()

# This family has a fixed entry point. It reuses the bounded REF2015 catalogue
# and does not pull in release RosettaScripts registrations for unrelated movers.
if(ROSETTATAB_CYCLIC_APPLICATION)
  if(NOT ROSETTATAB_RELAX)
    message(FATAL_ERROR "The cyclic application requires protocol libraries.")
  endif()
  add_executable(rosettatab-cyclic EXCLUDE_FROM_ALL boinc-application.cc cyclic-application.cc)
  target_link_libraries(rosettatab-cyclic PRIVATE rosetta_core rosetta_external)
  if(EMSCRIPTEN)
    set_target_properties(rosettatab-cyclic PROPERTIES OUTPUT_NAME rosetta-cyclic SUFFIX .mjs)
    get_target_property(CYCLIC_LINK_OPTIONS rosettatab-native LINK_OPTIONS)
    list(FILTER CYCLIC_LINK_OPTIONS EXCLUDE REGEX "EXPORTED_FUNCTIONS|JSPI_EXPORTS")
    target_link_options(rosettatab-cyclic PRIVATE ${CYCLIC_LINK_OPTIONS}
      "-sEXPORTED_FUNCTIONS=['_rosettatab_run_application','_main']")
    if(NOT ROSETTATAB_ASYNCIFY)
      target_link_options(rosettatab-cyclic PRIVATE "-sJSPI_EXPORTS=['rosettatab_run_application']")
    endif()
  else()
    target_link_libraries(rosettatab-cyclic PRIVATE Threads::Threads ${CMAKE_DL_LIBS})
  endif()
endif()
