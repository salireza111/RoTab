# Third-party components and scientific inputs

The MIT license covers original RoTab application and adapter code. Dependencies and scientific components retain their own licenses and attribution requirements.

- [Rosetta](https://github.com/RosettaCommons/rosetta/tree/369e400415dd5c585f80dcf7b647147ee520e8ba) supplies the scientific methods. Its upstream source, compiled runtime and database are not included here. The original integration references the pinned source commit; Rosetta's own license and citation requirements apply to separately obtained scientific assets.
- [Mol*](https://github.com/molstar/molstar), [React](https://github.com/facebook/react), [nostr-tools](https://github.com/nbd-wtf/nostr-tools), [Zod](https://github.com/colinhacks/zod) and other npm dependencies retain their package licenses. The lockfile records dependency versions. The standalone adapter includes its bundled Zod notice under `packages/rosetta-wasm/THIRD_PARTY_LICENSES/`.
- [Lucide](https://lucide.dev/license) icons use the ISC license. Search-provider icons identify Google, DuckDuckGo, Brave and Bing; the names and logos remain the property of their respective owners and imply no affiliation.
- Reference coordinates include [PDB 1L2Y](https://www.rcsb.org/structure/1L2Y) and [PDB 1UBQ](https://www.rcsb.org/structure/1UBQ). Scientific use should cite the structures and their associated publications. Included replay and packing fixtures are test/display data, separate from a new live calculation.
- Weather and location labels use [Open-Meteo](https://open-meteo.com/) and [Photon](https://photon.komoot.io/), with the provider/OpenStreetMap attribution displayed in the interface. Service terms and availability apply independently of the application license.

Rosetta engine bundles assembled separately retain the upstream Rosetta, Emscripten and external-library notices. This source repository does not redistribute a BOINC client or claim endorsement by RosettaCommons, Rosetta@home or BOINC.
