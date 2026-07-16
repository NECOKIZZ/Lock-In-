// Keeper: drives the fast settlement path (Solana build spec §5.5).
//
// The keeper is trustless-by-audit: everything it computes is a deterministic
// function of public on-chain data (each StakePosition's guess + stake, and the
// validated score), so anyone can recompute and challenge a wrong submission.
// It does NOT hold funds or keys to the escrow — it only calls `submit_settlement`,
// which the program independently verifies (recompute D, median order-statistic,
// conservation) before accepting.
//
// The compute half (`buildSettlement`) runs anywhere with `node`. The submit half
// (`submitToChain`) is the Anchor client wiring — shown here as the intended shape;
// it needs the built IDL + a funded keeper wallet to actually run against localnet.

import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { settle, distanceA, DEFAULT_DIST_PARAMS, DEFAULT_PAYOUT_PARAMS } from "./engine.ts";
import type { DistParams, PayoutParams } from "./engine.ts";
import type { ValidatedScore } from "./txline.ts";

/** Public data read from one StakePosition account. */
export interface OnChainPosition {
  pubkey: string; // StakePosition PDA (base58)
  guessHome: number;
  guessAway: number;
  stake: bigint; // USDC base units
}

/** One entry submitted per position, aligned with the account order. */
export interface SettlementEntry {
  distanceD: bigint;
  isWinner: boolean;
  accuracyA: bigint;
  payoutAmount: bigint;
}

export interface SettlementSubmission {
  medianD: bigint;
  platformCut: bigint;
  entries: SettlementEntry[];
  orderedPubkeys: string[]; // remaining_accounts order — must match `entries`
}

/**
 * Compute the full settlement off-chain from public inputs. This is the exact
 * same math the on-chain program would run in the full pipeline — the keeper
 * just does it in one pass and lets the program cheaply verify it.
 */
export function buildSettlement(
  actualHome: number,
  actualAway: number,
  positions: OnChainPosition[],
  distParams: DistParams = DEFAULT_DIST_PARAMS,
  payoutParams: PayoutParams = DEFAULT_PAYOUT_PARAMS,
): SettlementSubmission {
  const enginePositions = positions.map((p) => ({
    stake: p.stake,
    d: distanceA(p.guessHome, p.guessAway, actualHome, actualAway, distParams),
  }));

  const res = settle(enginePositions, payoutParams);
  if (res.void !== null) {
    throw new Error(`Round is void (${res.void}) — call the program's void path instead of submit_settlement.`);
  }

  const entries: SettlementEntry[] = res.outcomes.map((o, i) => ({
    distanceD: enginePositions[i].d,
    isWinner: o.isWinner,
    accuracyA: o.a,
    payoutAmount: o.payout,
  }));

  // Local re-check of the exact invariant the program enforces, so we never
  // submit something that will bounce.
  const paid = entries.reduce((s, e) => s + e.payoutAmount, 0n);
  if (paid + res.platformCut !== res.totalPool) {
    throw new Error("keeper conservation check failed — refusing to submit");
  }

  return {
    medianD: res.medianD,
    platformCut: res.platformCut,
    entries,
    orderedPubkeys: positions.map((p) => p.pubkey),
  };
}

// ---------------------------------------------------------------------------
// On-chain wiring (Anchor 0.30 client). Runtime deps: @coral-xyz/anchor,
// @solana/web3.js; and via txline.ts: @solana/spl-token, axios, tweetnacl, bn.js.
// Requires the built player_perps IDL (`anchor build` → target/idl/player_perps.json).
// ---------------------------------------------------------------------------

/**
 * Prove + store the final score on-chain. `player_perps.validate_score` re-verifies
 * the TxLine proof via CPI into `txoracle.validate_stat_v3` against the pinned daily
 * Merkle root, so a wrong (home, away) is rejected (`ScoreProofRejected`). The Merkle
 * verification is compute-heavy — raise the CU limit to the max.
 */
export async function validateScoreOnChain(
  playerPerps: anchor.Program,
  fixture: PublicKey,
  v: ValidatedScore,
): Promise<string> {
  return playerPerps.methods
    .validateScore(v.payload, v.home, v.away)
    .accounts({
      fixture,
      dailyScoresMerkleRoots: v.dailyScoresPda,
      txoracleProgram: v.txoracleProgramId,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .rpc();
}

/** Read every StakePosition for a fixture into the engine's input shape. */
export async function loadPositions(
  playerPerps: anchor.Program,
  fixture: PublicKey,
): Promise<OnChainPosition[]> {
  // StakePosition layout: 8 disc + fixture(32) → filter by the fixture pubkey.
  const accounts = await playerPerps.account.stakePosition.all([
    { memcmp: { offset: 8, bytes: fixture.toBase58() } },
  ]);
  return accounts.map((a) => {
    const d = a.account as any;
    return {
      pubkey: a.publicKey.toBase58(),
      guessHome: d.guessHome,
      guessAway: d.guessAway,
      stake: BigInt(d.stakeAmount.toString()),
    };
  });
}

/** Submit the fast-path settlement the program independently re-verifies. */
export async function submitToChain(
  playerPerps: anchor.Program,
  fixture: PublicKey,
  authority: anchor.web3.Keypair,
  s: SettlementSubmission,
): Promise<string> {
  return playerPerps.methods
    .submitSettlement(
      new anchor.BN(s.medianD.toString()),
      new anchor.BN(s.platformCut.toString()),
      s.entries.map((e) => ({
        distanceD: new anchor.BN(e.distanceD.toString()),
        isWinner: e.isWinner,
        accuracyA: new anchor.BN(e.accuracyA.toString()),
        payoutAmount: new anchor.BN(e.payoutAmount.toString()),
      })),
    )
    .accounts({ authority: authority.publicKey, fixture })
    .remainingAccounts(
      s.orderedPubkeys.map((pk) => ({
        pubkey: new PublicKey(pk),
        isSigner: false,
        isWritable: true,
      })),
    )
    .signers([authority])
    .rpc();
}

/**
 * End-to-end fast-path settlement for one fixture:
 *   validate score (real TxLine CPI) → read positions → compute → submit.
 * `txlineFixtureId` is TxLine's numeric fixture id; `fixture` is our on-chain PDA.
 */
export async function settleFixture(args: {
  playerPerps: anchor.Program;
  fixture: PublicKey;
  authority: anchor.web3.Keypair;
  validated: ValidatedScore;
}): Promise<{ validateSig: string; submitSig: string; submission: SettlementSubmission }> {
  const { playerPerps, fixture, authority, validated } = args;

  const validateSig = await validateScoreOnChain(playerPerps, fixture, validated);
  const positions = await loadPositions(playerPerps, fixture);
  const submission = buildSettlement(validated.home, validated.away, positions);
  const submitSig = await submitToChain(playerPerps, fixture, authority, submission);

  return { validateSig, submitSig, submission };
}
