# Devnet e2e artifacts (proven run 2026-07-14)

Full lifecycle proven live on devnet against the real txoracle CPI:
- program: `6krdS27r9oHpiTwHemWXwcKSns7Dj3616pFwKNDgmE26`
- settled fixture PDA: `7Nv6vQdpPiRPCmzSyvorCq54e4VCwhAHNG9dfjSuih38` (txline fixture 18218149, final 2-1)
- exact payouts on-chain: A=135906207, C=42093791, take=22000002, Σ=200000000 (spec §7, cent-rounded $135.91/$42.09/$22.00)

These scripts ran from a checkout of TxLine's `tx-on-chain` repo (deps + `common/users.ts`,
`idl/txoracle.json`, `types/txoracle.ts`, `engine.ts` copy live there — node_modules was
installed on the /tmp overlay for disk reasons). To rerun: clone tx-on-chain, drop these
into `examples/devnet/`, and:

    ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
    ANCHOR_WALLET=keeper/.keys/keeper-devnet.json \
    TOKEN_MINT_ADDRESS=4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG \
    npx tsx examples/devnet/pp-e2e.ts

- `pp-e2e.ts` — initialize → stake x5 → lock → validate_score (real CPI) → settle → claim + §7 asserts
- `verify-onchain.ts` — read-only re-verification of the settled fixture (no writes, safe anytime)
- `gen-pp-idl.mjs` — regenerates player_perps IDL (no anchor CLI needed; computes discriminators, lifts txoracle types)
- `probe-validate.ts` — step-0 probe: fetch V3 proof, on-chain validate (true), tamper test (false), tx-size

Build gotcha on this box: `cargo build-sbf` fails with "invalid custom toolchain name" —
old rustup rejects the platform-tools toolchain name. Fix: shim dir first on PATH where
`cargo` strips a leading `+toolchain` arg and execs
`~/.cache/solana/v1.54/platform-tools/rust/bin/cargo`, and `rustup toolchain link` is a
no-op symlink creator (see /tmp/shim in session, recreate if needed).

## Listing agent + monitor (built & proven live 2026-07-14 late)

- `lister.ts` — discovery (`/fixtures/snapshot`, comps 72+430, today..+2 days) → gates
  G1 feed-live / G2 publisher-alive (today's daily root) / G3 soccer / G4 scheduled+KO>10min
  → `initialize_fixture(id, lock_time = feed StartTime)` → writes `app/ui/fixtures.json`.
  Idempotent: already-listed and already-on-chain fixtures are skipped/refreshed.
  Feed quirks: comp-430 fixture records have GameState numeric 1 (not "scheduled") and
  NO SportId — sport is read from the first /scores/snapshot record instead.
- `monitor.ts` — per registry market: Open→lock at KO; Locked→poll snapshot for
  game_finalised→validate_score (real CPI, G2 recheck on the record's day root)→
  ScoreValidated→ submit_settlement, or compute_distances_batch when engine says void
  (<2 stakers / all-equal-D) which flips status to Void (refunds). One pass per run;
  `LOOP=1 POLL_MS=60000` to poll. Updates fixtures.json state/pool/stakers each pass.
- `monitor-e2e-setup.ts` — relists an already-finalised devnet sample with a short lock
  + 3 real stakes to rehearse the whole path. `claim-payouts.ts` — claims + engine cross-check.
- IDL regenerated with the 5 pipeline instructions (needed for the Void path).

Proven live on devnet:
- FRA-ESP 18237038: locked at KO, real final 0-2 validated via CPI, VOID (0 stakers), registry updated.
- 18222446 (final 3-1): listed+staked ($50 on 3-1, $30 on 2-1, $20 on 0-0) → locked →
  validated 3-1 → SETTLED median D 1.5, take $10, winner claimed $90, conservation exact.
- ENG-ARG 18241006 still Open, KO 2026-07-15T19:00Z — run monitor.ts after KO to settle it.

Same env vars as pp-e2e.ts. Files must be copied into a tx-on-chain checkout's
examples/devnet/ (plus engine.ts from keeper/src) — deps live there on /tmp.
