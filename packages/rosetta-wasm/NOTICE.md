# Scientific engine and adapter licensing

The JavaScript/TypeScript adapter and original documentation use the repository's MIT license, reproduced in `LICENSE`. The npm-ready adapter archive excludes Rosetta's JS glue, WASM binary and database.

Rosetta scientific source, compiled engine and database are governed separately by the [pinned Rosetta license](https://github.com/RosettaCommons/rosetta/blob/369e400415dd5c585f80dcf7b647147ee520e8ba/LICENSE.md), not this adapter's MIT license. A scientific bundle retains `engine/ROSETTA_LICENSE.md` and `engine/CITING_ROSETTA.md`. Compiling to WASM does not grant new distribution rights; scientific redistribution remains subject to the applicable Rosetta terms.

Adapter code bundles the repository's existing PDB preparation/validation policy. Its Zod dependency is bundled and its MIT notice is retained in `THIRD_PARTY_LICENSES/Zod.txt`; there is no consumer runtime dependency on the extension or private workspace packages.

This is an independent research port. It is not an official Rosetta@home application, BOINC client, project-approved validator or credit mechanism. File hashes identify the measured scientific build; they do not attest that an untrusted volunteer performed correct science.
