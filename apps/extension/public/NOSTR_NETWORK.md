# RoTab volunteer network

RoTab uses public Nostr relays for volunteer discovery and encrypted connection signaling. WebRTC transfers scientific inputs and results between browsers. The publishing browser stores a campaign and coordinates its assignments; it must remain open to distribute work and collect returns.

## Participation

Discovery is enabled by default, while automatic task acceptance is off. **Start volunteering** enables future compatible assignments. **Contribute** accepts one model. **Pause new tasks** stops new acceptance while an active model finishes. Campaigns and volunteers must use compatible application protocols and exact scientific engine identities.

The paper-plane control opens **Volunteer network**. A publisher supplies an admitted protein, method, model count, seed and short research description. **Also calculate on this browser** allows the publisher to join the model queue. Campaign controls expose queued, assigned, running and completed work, with progress reported by the assigned browser. Online presence alone does not mean calculation is running.

## Connections

The default discovery room is `rotab-pilot-v3`; default relays are `wss://relay.damus.io` and `wss://nos.lol`. Room names are public topics, not passwords. Relay settings permit custom secure relays and STUN/TURN configuration. Socket connectivity and accepted relay writes are reported separately.

STUN assists direct route discovery. TURN carries encrypted WebRTC traffic when a direct connection is unavailable. This public source build contains no shared TURN credentials. A working TURN service can be configured locally in connection settings. **Test TURN** checks allocation only; it does not start a scientific calculation or establish end-to-end job delivery. Custom authentication is omitted from diagnostics and scientific exports.

## Results and recovery

Completed models and pending results are stored locally. An unfinished model can restart from its recorded seed after recovery. Renewable leases fence reassigned or cancelled work; pending signed returns retry until acknowledged. Returned energies remain scientifically unverified until checked independently.

Exports can contain complete structures, campaign descriptions and participant identifiers. Relays see connection metadata, signed presence and bounded capability/availability information. They do not receive plaintext protein inputs or results. Recipients of a scientific transfer can retain the files they receive.

## Local resource controls

The extension defaults to one worker at 10% cooperative intensity, with a rest between automatic network models. Settings control worker count, intensity and molecular rotation. Initialization occurs in each fresh calculation worker and can precede cooperative throttling. These settings do not establish a temperature or fan-speed limit.

This workflow uses RoTab campaigns. It does not acquire official Rosetta@home workunits, submit results to that project or award BOINC credit. Source-only builds require separately built and verified scientific assets before they can calculate.

[Connection architecture](https://salireza111.github.io/RoTab_Doc/extension/connections.html) · [Job architecture](https://salireza111.github.io/RoTab_Doc/extension/jobs.html) · [TURN help](https://salireza111.github.io/RoTab_Doc/help/turn.html)
