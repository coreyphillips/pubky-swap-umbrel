# Bitkit durable delivery integration

Release `0.2.5`, prepared on 2026-09-28, connects the
Umbrel provider, pubky-swap-boltz, bitkit-core, and the Android `feat/pubky-swap-boltz` branch.
The upstream contract is documented in
[BITKIT_HANDOFF.md](https://github.com/coreyphillips/pubky-swap/blob/main/docs/BITKIT_HANDOFF.md).

## Build identity

| Component | Selected source or package |
| --- | --- |
| Swap engine and transport | `ca3d5f375da4f1248023a33d7e5c060083e5fc72` |
| Messenger | `4fff0ce2183f7273c0418801c262ed291a0a145a` |
| Rust | `1.95.0` |
| Umbrel dashboard release | `0.2.5` |
| Local Android core package | `0.5.14-pubky-durable-20260928-local` |

Core still uses a local wrapper path override. The wrapper itself fetches the exact swap
revision above. A published, reproducible dependency chain requires publishing the reviewed
wrapper and replacing that final local override with its immutable revision.

## Connect a matching Bitkit build

The community store selects the published `0.2.5` image. The separate
[local candidate instructions](LOCAL_CANDIDATE.md) cover the retained ARM64 test archive.

1. Use the mainnet build for `bitcoin`, or the development build for `regtest`. Install the
   matching Pubky Ring build with the same signing certificate.
2. For regtest, set Bitkit's Electrum endpoint to the same isolated chain before funding.
   Its dev default uses shared staging infrastructure. Establish a reachable Lightning peer
   and sufficient channel liquidity; scanning the QR configures neither of these.
3. Configure the Umbrel provider's registered Pubky identity, Lightning backend, Electrum
   endpoint, and liquidity. Wait for the provider to report its live identity and network.
4. Scan **Overview > Connect** from Bitkit, or open its connection link on the phone. Complete
   the Pubky Ring identity selection when prompted.
5. Use the supported Savings transfer or payment flow. The selected network and the liquidity
   needed for that swap direction must match on both sides.

Delivery state and swap contracts remain in persistent storage. A timeout after possible
acceptance is recoverable and must not trigger an unrelated replacement swap or duplicate
invoice payment. Developer Settings exposes paused delivery operations for deliberate retry.

## Validation record

- Umbrel dashboard tests: 53 passed on the host and inside the final Node 20 image with
  networking disabled. This includes reset backoff and obsolete-response regressions found
  while replacing the test provider identity.
- ARM64 image built successfully. Offline identity loading and rejection of invalid recovery
  input passed with networking disabled. Dashboard startup, version, regtest selection,
  unconfigured state, page serving, and private-volume ownership and modes passed.
- Wrapper mobile tests: 55 passed; strict all-feature Clippy passed.
- Core swap tests: 71 passed, with one live Boltz test intentionally skipped; Clippy passed
  with existing warnings in unrelated code.
- All four Android ABIs compiled. Matching Kotlin bindings, JNI exports, machine types,
  stripping, and 16 KiB alignment were verified. The published local AAR contains the exact
  verified libraries. Generated Kotlin retains the generator's whitespace.
- Mainnet and regtest Kotlin compilation and APK assembly passed. The full Android unit run
  had 2,572 passes and 12 failures caused by two outdated mock fixtures. After correcting those
  test fixtures, all 119 tests in the two affected classes passed, including all 12 former failures.
- Both signed ARM64 app APKs passed signature and 16 KiB ZIP alignment checks. Their packaged
  core libraries exactly match the arm64 library in the local AAR. Both generated Kotlin files
  match the published local sources JAR.
- All three device checks passed on the isolated 16 KiB-page emulator: native bootstrap and
  new recovery/payment APIs, Ring signature permissions and identity access, and decoding
  Umbrel's QR bitmap with the packaged ML Kit decoder.
- The public connection link survived fresh regtest wallet onboarding, saved the exact provider,
  enabled swaps, and opened identity selection. Ring had no identities, so the expected empty
  picker appeared. No public identity or payment was created.
- A wrong-network connection displayed the expected error and preserved the provider and
  enabled state. Importing the Umbrel QR GIF through the actual scanner's gallery flow changed
  a different saved provider to the exact fixture key, with swaps enabled.
- Final Android lint passed after the test-fixture corrections, with the same existing warnings.
- The separate local candidate Compose configuration passed validation with inert fixture values.
- Release validation and storage migration tests: 15 passed in isolated Node 20 Linux without
  networking. The release checker also accepted the existing published `0.2.4` image, matching
  the tag to its exact digest and confirming both runnable Linux architectures.
- The published `0.2.5` tag and combined digest matched through anonymous registry access.
  Both published AMD64 and ARM64 images passed CLI and valid/invalid offline identity checks,
  plus unconfigured mainnet and regtest dashboard startup, version, page and private-volume
  permission checks. All runtime smoke containers had networking disabled and no host data mounts.
- A later isolated funded setup imported an existing registered identity through Ring, selected
  and authenticated it through Bitkit, and connected Bitkit to the same regtest Electrum server.
  Bitkit received 2,000,000 regtest sats and opened a 1,000,000-sat channel to the provider's LND.
  The channel became active with 999,056 spendable sats. Restart preserved the identity and
  active channel.
- The live provider QR configured Bitkit and returned a quote. A 49,999-sat Lightning-to-on-chain
  swap funded a 47,509-sat lockup. Bitkit was force-stopped before confirmation, and the provider
  container was replaced with the final local image while preserving the same data volume.
  The provider recovered the same swap, invoice and lockup. After three confirmations, reopening
  Bitkit automatically claimed 47,369 sats with a 140-sat claim fee. The original invoice settled
  with one HTLC; no new swap, repeat payment or manual claim was needed. The claim transaction
  was confirmed in the isolated chain. The quote's conservative receive estimate was 46,604 sats.
- The Bitcoin payment flow from Spending paid exactly 25,000 sats to a separate regtest wallet.
  Its 28,346-sat invoice settled once, and the claim spent a 25,900-sat lockup with the reviewed
  900-sat fee. An expired review was rejected before creating or paying a swap; normal retry
  with refreshed terms succeeded. The recipient output was independently confirmed.
- At final height 128, both original swaps were claimed, both original invoices were settled
  with one HTLC each, and the provider reported zero active swaps, in-flight swaps or committed
  sats. A final Bitkit restart preserved both results without creating another invoice. The
  isolated containers and emulator were stopped with their data retained.

The local image is `pubky-swap-app:durable-20260928`, image ID
`sha256:fb52657c69671b28006e9bf87227c50a49c913061287b4d48cac10f2338c9052`.
The portable ARM64 archive is `dist/pubky-swap-app-0.2.5-arm64.tar.gz`, with `dist/SHA256SUMS`.
This local image ID is not a published multi-architecture registry digest.

The local core AAR SHA-256 is
`022716b7bfed9aaaf9a7109e51ff1cf4f6073cd777702bd8f52de70bbb24813f`.
The core checkout's `dist` directory contains the full checksum and JNI verification reports
for `0.5.14-pubky-durable-20260928-local`.

The Android checkout contains the installable artifacts in
`app/build/outputs/pubky-durable-20260928`, alongside `apk-verification.json` and the detailed
`VALIDATION.md` device report:

| App artifact | SHA-256 |
| --- | --- |
| `bitkit-mainnet-pubky-durable-20260928-arm64.apk` | `1b7e052969d84b3aa96073efa7d26388005bb2f77c4835ff2a6ff9f273c4d668` |
| `bitkit-regtest-pubky-durable-20260928-arm64.apk` | `be591954cd5ccb29be4086deed18376bd073a7c705e1e8996f75b973079f334c` |

Both are version `2.4.1` build `191`. Pair them with the existing Ring demo APK at
`android/app/build/outputs/apk/release/pubky-ring-demo.apk` in the Ring checkout.
These are local debug builds. A differently signed production Ring installation cannot grant
their shared-identity permission, and the mainnet Firebase placeholder does not provide
production push messaging.
The shared certificate SHA-256 is
`84d38f92d272f49992d8d583ae6b0b5c7b1914340b69ca6f619c93693bf47971`.
The arm64 `libbitkitcore.so` SHA-256 in both apps and the AAR is
`50f71267feb47cd11899700bfe75356eb850016a4eacd252a9108b4927ae9711`.

The isolated device test used a QR bitmap made by Umbrel's bundled encoder. Bitmap decoding,
gallery application, connection-link routing, selecting and authenticating a registered Ring
identity, authenticated swap negotiation, and funded reverse settlement after process restart
passed. Physical camera capture has not been exercised.

## Current limits

- The current Bitkit UI exposes Pubky Lightning-to-on-chain swaps through Savings transfers
  and Bitcoin payments from Spending. Savings-to-Spending still uses Blocktank; the native
  Pubky submarine methods have no UI caller in this branch.
- Creation resources are retained conservatively. Complete terminal cleanup and reorg
  lifecycle validation are not established by a locally recorded claim or refund transaction ID.
- Android recovery uses the original device storage. Its cloud backup does not include these
  Pubky contracts, delivery journals, or imported identities. Core rejects logical backup and
  restore when delivery journals would be omitted or existing stores would be shadowed.
- The selected client and replacement provider identities sign in through both the pinned legacy
  SDK and the modern SDK. No new account was created. The current builds do not expose local
  Pubky resolver configuration. The funded check above covers one reverse swap across both
  process restarts. Two concurrent mobile swaps, process interruption during negotiation dispatch,
  live paused-delivery retry, and full cleanup/reorg behavior remain unverified on the device.
- Live and mobile performance measurements remain tracked in
  [issue 85](https://github.com/coreyphillips/pubky-swap/issues/85).

## Publication

The implementation merged in [PR 29](https://github.com/coreyphillips/pubky-swap-umbrel/pull/29).
The signed `v0.2.5` tag selects source commit `28ecafa93240a1df6ff67a93d99fe7e9e2498d3a`.
The [native image build](https://github.com/coreyphillips/pubky-swap-umbrel/actions/runs/36466802403)
passed for AMD64 and ARM64. The store manifest and compose file pin the published image:

`ghcr.io/coreyphillips/pubky-swap-app:0.2.5@sha256:abbe9dfb7a3743a51416b8f910de561da3736c4cd9eb0c29845a10e37c39981f`.

Publish and pin the wrapper dependency before describing the core source as independently
reproducible. Existing unrelated local changes in the downstream repositories remain preserved.
