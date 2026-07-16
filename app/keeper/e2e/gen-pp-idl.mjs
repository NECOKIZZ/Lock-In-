// Generate a hand-authored Anchor 0.30 IDL for player_perps (no anchor CLI here).
// Computes discriminators the way Anchor does and lifts the StatValidationInputV3
// type graph verbatim from the txoracle IDL so the two stay byte-compatible.
import { createHash } from "node:crypto";
import fs from "node:fs";

const PROGRAM_ID = "6krdS27r9oHpiTwHemWXwcKSns7Dj3616pFwKNDgmE26";
const tx = JSON.parse(fs.readFileSync("/tmp/tx-on-chain/idl/txoracle.json", "utf8"));

const disc = (prefix, name) => Array.from(createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8));
const liftType = (n) => tx.types.find((t) => t.name === n) ?? (() => { throw new Error("missing txoracle type " + n); })();

// Types lifted from txoracle (must match the CPI arg layout exactly).
const TXO_TYPES = ["StatValidationInputV3", "ScoresBatchSummary", "ScoresUpdateStats", "ProofNode", "StatLeaf", "ScoreStat"].map(liftType);

const ix = (name, args, accounts) => ({ name, discriminator: disc("global", name), accounts, args });
const acc = (name, opts = {}) => ({ name, writable: !!opts.w, signer: !!opts.s });

const idl = {
  address: PROGRAM_ID,
  metadata: { name: "player_perps", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    ix("initialize_fixture",
      [
        { name: "txline_fixture_id", type: "u64" },
        { name: "lock_time", type: "i64" },
        { name: "dist_params", type: { defined: { name: "DistParams" } } },
        { name: "payout_params", type: { defined: { name: "PayoutParams" } } },
      ],
      [
        acc("authority", { w: true, s: true }),
        acc("fixture", { w: true }),
        acc("usdc_mint"),
        acc("escrow", { w: true }),
        acc("token_program"),
        acc("associated_token_program"),
        acc("system_program"),
      ]),
    ix("stake",
      [
        { name: "guess_home", type: "u8" },
        { name: "guess_away", type: "u8" },
        { name: "amount", type: "u64" },
      ],
      [
        acc("staker", { w: true, s: true }),
        acc("fixture", { w: true }),
        acc("position", { w: true }),
        acc("staker_usdc", { w: true }),
        acc("escrow", { w: true }),
        acc("token_program"),
        acc("system_program"),
      ]),
    ix("lock_fixture", [], [acc("fixture", { w: true })]),
    ix("validate_score",
      [
        { name: "payload", type: { defined: { name: "StatValidationInputV3" } } },
        { name: "home", type: "u8" },
        { name: "away", type: "u8" },
      ],
      [
        acc("fixture", { w: true }),
        acc("daily_scores_merkle_roots"),
        acc("txoracle_program"),
      ]),
    ix("submit_settlement",
      [
        { name: "median_d", type: "u64" },
        { name: "platform_cut", type: "u64" },
        { name: "entries", type: { vec: { defined: { name: "SettlementEntry" } } } },
      ],
      [
        acc("authority", { s: true }),
        acc("fixture", { w: true }),
      ]),
    // Pipeline phases (§5.4) — all share the PipelineBatch accounts; positions go
    // in remaining_accounts. The monitor uses compute_distances_batch to reach Void.
    ix("compute_distances_batch", [], [acc("keeper", { s: true }), acc("fixture", { w: true })]),
    ix("verify_median_candidate", [{ name: "candidate", type: "u64" }], [acc("keeper", { s: true }), acc("fixture", { w: true })]),
    ix("finalize_median", [], [acc("keeper", { s: true }), acc("fixture", { w: true })]),
    ix("settle_batch", [], [acc("keeper", { s: true }), acc("fixture", { w: true })]),
    ix("compute_payouts_batch", [], [acc("keeper", { s: true }), acc("fixture", { w: true })]),
    ix("claim_payout", [],
      [
        acc("staker", { w: true, s: true }),
        acc("fixture"),
        acc("position", { w: true }),
        acc("escrow", { w: true }),
        acc("staker_usdc", { w: true }),
        acc("token_program"),
      ]),
  ],
  accounts: [
    { name: "Fixture", discriminator: disc("account", "Fixture") },
    { name: "StakePosition", discriminator: disc("account", "StakePosition") },
  ],
  types: [
    ...TXO_TYPES,
    { name: "DistParams", type: { kind: "struct", fields: [
      { name: "p", type: "u64" }, { name: "w_gd", type: "u64" }, { name: "w_tg", type: "u64" },
      { name: "w_cs", type: "u64" }, { name: "cap_gd", type: "u8" }, { name: "cap_tg", type: "u8" }] } },
    { name: "PayoutParams", type: { kind: "struct", fields: [
      { name: "gamma", type: "u32" }, { name: "take_rate_bps", type: "u16" }, { name: "cap_multiple", type: "u64" }] } },
    { name: "SettlementEntry", type: { kind: "struct", fields: [
      { name: "distance_d", type: "u64" }, { name: "is_winner", type: "bool" },
      { name: "accuracy_a", type: "u128" }, { name: "payout_amount", type: "u64" }] } },
    { name: "FixtureStatus", type: { kind: "enum", variants: [
      { name: "Open" }, { name: "Locked" }, { name: "ScoreValidated" }, { name: "DistancesComputed" },
      { name: "MedianVerified" }, { name: "Settled" }, { name: "Void" }] } },
    { name: "Fixture", type: { kind: "struct", fields: [
      { name: "txline_fixture_id", type: "u64" }, { name: "lock_time", type: "i64" },
      { name: "status", type: { defined: { name: "FixtureStatus" } } },
      { name: "dist_params", type: { defined: { name: "DistParams" } } },
      { name: "payout_params", type: { defined: { name: "PayoutParams" } } },
      { name: "actual_home", type: "u8" }, { name: "actual_away", type: "u8" },
      { name: "total_pool", type: "u64" }, { name: "staker_count", type: "u16" },
      { name: "usdc_mint", type: "pubkey" }, { name: "escrow", type: "pubkey" }, { name: "authority", type: "pubkey" },
      { name: "bump", type: "u8" },
      { name: "distances_computed_count", type: "u16" }, { name: "running_min_d", type: "u64" },
      { name: "running_max_d", type: "u64" }, { name: "running_count_at_min", type: "u16" },
      { name: "median_candidate", type: "u64" }, { name: "median_count_below", type: "u16" },
      { name: "median_count_equal", type: "u16" }, { name: "median_verify_count", type: "u16" },
      { name: "median_d", type: "u64" }, { name: "median_verified", type: "bool" },
      { name: "coalition_mode", type: "bool" }, { name: "winners_processed_count", type: "u16" },
      { name: "sum_a", type: "u128" }, { name: "losers_stake_sum", type: "u64" },
      { name: "dividend_pool", type: "u64" }, { name: "platform_cut", type: "u64" },
      { name: "waterfill_round", type: "u8" }, { name: "capped_gain_sum", type: "u64" },
      { name: "capped_a_sum", type: "u128" }, { name: "payouts_finalized_count", type: "u16" },
      { name: "undistributed", type: "u64" }] } },
    { name: "StakePosition", type: { kind: "struct", fields: [
      { name: "fixture", type: "pubkey" }, { name: "staker", type: "pubkey" },
      { name: "guess_home", type: "u8" }, { name: "guess_away", type: "u8" },
      { name: "stake_amount", type: "u64" }, { name: "distance_d", type: "u64" },
      { name: "is_winner", type: "bool" }, { name: "accuracy_a", type: "u128" },
      { name: "capped", type: "bool" }, { name: "payout_amount", type: "u64" },
      { name: "claimed", type: "bool" }, { name: "bump", type: "u8" }] } },
  ],
};

fs.writeFileSync("/tmp/tx-on-chain/examples/devnet/player_perps.idl.json", JSON.stringify(idl, null, 2));
console.log("wrote player_perps.idl.json — instructions:", idl.instructions.map((i) => i.name).join(", "));
console.log("lifted txoracle types:", TXO_TYPES.map((t) => t.name).join(", "));
