// Player Perps full lifecycle on devnet against the LIVE txoracle CPI.
//   initialize_fixture → stake x5 → lock → validate_score(real proof) → submit_settlement → claim
// Uses devnet sample fixture 18218149 (final 2-1) as the proven score, and the exact
// spec-§7 five-staker scenario, so on-chain payouts must equal the Rust engine's numbers.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountInstruction, createMintToInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Txoracle } from "./types/txoracle";
import TxoracleJson from "./idl/txoracle.json";
import PpIdl from "./player_perps.idl.json";
import * as users from "./common/users";
import { settle, distanceA, DEFAULT_DIST_PARAMS, DEFAULT_PAYOUT_PARAMS } from "./engine.ts";
import * as fs from "fs";

const FIXTURE_ID = 18218149, SEQ = 1087;
const TXORACLE_DEVNET = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const AUTH_CACHE = "/tmp/txline-auth.json";
const usdc = (d: number) => BigInt(d) * 1_000_000n;
const fmt = (b: bigint) => `$${(Number(b) / 1e6).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parseHash = (h: any): number[] => { const raw = h?.hash ?? h; return typeof raw === "string" ? Array.from(raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64")) : Array.from(raw); };
const mapProof = (p: any[]) => (p ?? []).map((n) => ({ hash: parseHash(n), isRightSibling: n.isRightSibling ?? false }));

const STAKERS = [
  { name: "A", gh: 2, ga: 1, stake: 50 },
  { name: "C", gh: 3, ga: 1, stake: 40 },
  { name: "B", gh: 2, ga: 0, stake: 30 },
  { name: "D", gh: 1, ga: 1, stake: 20 },
  { name: "E", gh: 1, ga: 2, stake: 60 },
];

function buildSettlement(home: number, away: number, positions: any[]) {
  const ep = positions.map((p) => ({ stake: p.stake, d: distanceA(p.guessHome, p.guessAway, home, away, DEFAULT_DIST_PARAMS) }));
  const res = settle(ep, DEFAULT_PAYOUT_PARAMS);
  if (res.void !== null) throw new Error("void round: " + res.void);
  const entries = res.outcomes.map((o: any, i: number) => ({ distanceD: ep[i].d, isWinner: o.isWinner, accuracyA: o.a, payoutAmount: o.payout }));
  return { medianD: res.medianD, platformCut: res.platformCut, entries, orderedPubkeys: positions.map((p) => p.pubkey) };
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const keeper = (provider.wallet as anchor.Wallet).payer;
  const tokenMint = new PublicKey(process.env.TOKEN_MINT_ADDRESS!);
  const walletPath = process.env.ANCHOR_WALLET!;

  const txo = new Program<Txoracle>(TxoracleJson as unknown as Txoracle, provider);
  const pp = new Program(PpIdl as anchor.Idl, provider);
  console.log("player_perps:", pp.programId.toBase58(), "| keeper:", keeper.publicKey.toBase58());

  // ---- 1. auth + fetch the real final-score proof ----
  let cached: any = {}; try { cached = JSON.parse(fs.readFileSync(AUTH_CACHE, "utf8")); } catch {}
  await users.setupUser("Keeper", walletPath, tokenMint, connection, txo, 1, 4, [], cached.jwt, cached.apiToken);
  fs.writeFileSync(AUTH_CACHE, JSON.stringify({ jwt: users.authState.jwt, apiToken: users.authState.apiToken }));
  const val = (await users.apiClient.get(`/scores/stat-validation-v3?fixtureId=${FIXTURE_ID}&seq=${SEQ}&statKeys=1,2`)).data;
  const targetTs = Number(val.summary.updateStats.minTimestamp);
  const payload = {
    ts: new BN(targetTs),
    fixtureSummary: { fixtureId: new BN(val.summary.fixtureId), updateStats: { updateCount: val.summary.updateStats.updateCount, minTimestamp: new BN(val.summary.updateStats.minTimestamp), maxTimestamp: new BN(val.summary.updateStats.maxTimestamp) }, eventsSubTreeRoot: parseHash(val.summary.eventStatsSubTreeRoot) },
    fixtureProof: mapProof(val.subTreeProof), mainTreeProof: mapProof(val.mainTreeProof), eventStatRoot: parseHash(val.eventStatRoot),
    leaves: val.statsToProve.map((l: any) => ({ stat: l.stat, statProof: mapProof(l.statProof) })), leafIndices: val.multiproof.indices, multiproofHashes: mapProof(val.multiproof.hashes),
  };
  const home = Number(payload.leaves[0].stat.value), away = Number(payload.leaves[1].stat.value);
  const epochDay = Math.floor(targetTs / 86400000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], TXORACLE_DEVNET);
  console.log(`proof: final score ${home}-${away}, dailyScoresPda ${dailyScoresPda.toBase58()}`);

  // ---- 2. devnet "USDC" mint ----
  const usdcMint = await createMint(connection, keeper, keeper.publicKey, null, 6);
  console.log("USDC mint:", usdcMint.toBase58());

  const idBuf = new BN(FIXTURE_ID).toArrayLike(Buffer, "le", 8);
  const [fixturePda] = PublicKey.findProgramAddressSync([Buffer.from("fixture"), idBuf], pp.programId);
  const escrow = getAssociatedTokenAddressSync(usdcMint, fixturePda, true);

  // ---- 3. initialize_fixture (lock 100s out so all 5 stakes land first) ----
  const lockTime = Math.floor(Date.now() / 1000) + 100;
  const D = DEFAULT_DIST_PARAMS, P = DEFAULT_PAYOUT_PARAMS;
  await pp.methods.initializeFixture(new BN(FIXTURE_ID), new BN(lockTime),
    { p: new BN(D.p), wGd: new BN(D.wGd), wTg: new BN(D.wTg), wCs: new BN(D.wCs), capGd: D.capGd, capTg: D.capTg },
    { gamma: P.gamma, takeRateBps: P.takeRateBps, capMultiple: new BN(P.capMultiple) })
    .accountsStrict({ authority: keeper.publicKey, fixture: fixturePda, usdcMint, escrow, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("✓ initialize_fixture");

  // ---- 4. five stakers: batch setup (few txs) then stake, throttled for the public RPC ----
  const kps = STAKERS.map(() => Keypair.generate());
  const atas = kps.map((kp) => getAssociatedTokenAddressSync(usdcMint, kp.publicKey));
  // one tx: fund all stakers with SOL
  const fundTx = new Transaction();
  kps.forEach((kp) => fundTx.add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: kp.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })));
  await sendAndConfirmTransaction(connection, fundTx, [keeper]); await sleep(1500);
  // one tx: create all USDC ATAs
  const ataTx = new Transaction();
  kps.forEach((kp, i) => ataTx.add(createAssociatedTokenAccountInstruction(keeper.publicKey, atas[i], kp.publicKey, usdcMint)));
  await sendAndConfirmTransaction(connection, ataTx, [keeper]); await sleep(1500);
  // one tx: mint each staker's stake
  const mintTx = new Transaction();
  STAKERS.forEach((s, i) => mintTx.add(createMintToInstruction(usdcMint, atas[i], keeper.publicKey, usdc(s.stake))));
  await sendAndConfirmTransaction(connection, mintTx, [keeper]); await sleep(1500);
  console.log("✓ funded + minted 5 stakers");

  const positions: any[] = [];
  for (let i = 0; i < STAKERS.length; i++) {
    const s = STAKERS[i], kp = kps[i], ata = atas[i];
    const [posPda] = PublicKey.findProgramAddressSync([Buffer.from("stake"), idBuf, kp.publicKey.toBuffer()], pp.programId);
    await pp.methods.stake(s.gh, s.ga, new BN(usdc(s.stake)))
      .accountsStrict({ staker: kp.publicKey, fixture: fixturePda, position: posPda, stakerUsdc: ata, escrow, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([kp]).rpc();
    positions.push({ pubkey: posPda.toBase58(), posPda, kp, ata, guessHome: s.gh, guessAway: s.ga, stake: usdc(s.stake), name: s.name });
    console.log(`✓ stake ${s.name} ${s.gh}-${s.ga} ${fmt(usdc(s.stake))}`);
    await sleep(1500);
  }

  // ---- 5. lock (after lockTime) ----
  const waitMs = (lockTime + 3) * 1000 - Date.now();
  if (waitMs > 0) { console.log(`waiting ${(waitMs / 1000).toFixed(0)}s for lock window...`); await sleep(waitMs); }
  await pp.methods.lockFixture().accountsStrict({ fixture: fixturePda }).rpc();
  console.log("✓ lock_fixture");

  // ---- 6. validate_score via REAL txoracle CPI ----
  await pp.methods.validateScore(payload as any, home, away)
    .accountsStrict({ fixture: fixturePda, dailyScoresMerkleRoots: dailyScoresPda, txoracleProgram: TXORACLE_DEVNET })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
  const fx1 = await (pp.account as any).fixture.fetch(fixturePda);
  console.log(`✓ validate_score — on-chain stored score ${fx1.actualHome}-${fx1.actualAway}, status`, fx1.status);

  // ---- 7. submit_settlement (fast path) ----
  const sub = buildSettlement(home, away, positions);
  await pp.methods.submitSettlement(new BN(sub.medianD), new BN(sub.platformCut),
    sub.entries.map((e: any) => ({ distanceD: new BN(e.distanceD), isWinner: e.isWinner, accuracyA: new BN(e.accuracyA), payoutAmount: new BN(e.payoutAmount) })))
    .accountsStrict({ authority: keeper.publicKey, fixture: fixturePda })
    .remainingAccounts(positions.map((p) => ({ pubkey: p.posPda, isSigner: false, isWritable: true }))).rpc();
  console.log(`✓ submit_settlement — median D ${fmt(sub.medianD)}, platform take ${fmt(sub.platformCut)}`);

  // ---- 8. claim + verify balances ----
  console.log("\nstaker  guess  stake     payout     received(ATA)");
  let paid = 0n;
  for (const p of positions) {
    const pos = await (pp.account as any).stakePosition.fetch(p.posPda);
    const payout = BigInt(pos.payoutAmount.toString());
    paid += payout;
    if (payout > 0n) {
      await pp.methods.claimPayout().accountsStrict({ staker: p.kp.publicKey, fixture: fixturePda, position: p.posPda, escrow, stakerUsdc: p.ata, tokenProgram: TOKEN_PROGRAM_ID }).signers([p.kp]).rpc();
      await sleep(1200);
    }
    const bal = (await getAccount(connection, p.ata)).amount;
    console.log(`  ${p.name}     ${p.guessHome}-${p.guessAway}   ${fmt(p.stake).padStart(7)}  ${fmt(payout).padStart(9)}  ${fmt(bal).padStart(9)}`);
    await sleep(800);
  }

  // ---- 9. assert §7 economics ----
  const fx = await (pp.account as any).fixture.fetch(fixturePda);
  const A = await (pp.account as any).stakePosition.fetch(positions[0].posPda);
  const C = await (pp.account as any).stakePosition.fetch(positions[1].posPda);
  const ok = (c: boolean, m: string) => console.log((c ? "✓" : "✗ FAIL") + " " + m);
  console.log("\n=== assertions (spec §7) ===");
  ok(fx.actualHome === 2 && fx.actualAway === 1, `actual score 2-1 (got ${fx.actualHome}-${fx.actualAway})`);
  ok(sub.medianD === 1_750_000n, `median D = 1.75 (got ${fmt(sub.medianD)})`);
  // Exact engine integers (spec §7 quotes these rounded to cents: $135.91 / $42.09 / $22.00).
  ok(A.payoutAmount.toString() === "135906207", `A payout $135.906207 (got ${fmt(BigInt(A.payoutAmount.toString()))})`);
  ok(C.payoutAmount.toString() === "42093791", `C payout $42.093791 (got ${fmt(BigInt(C.payoutAmount.toString()))})`);
  ok(sub.platformCut === 22_000_002n, `platform take $22.000002 (got ${fmt(sub.platformCut)})`);
  ok(paid + sub.platformCut === usdc(200), `conservation Σpayout+take = $200.00 (got ${fmt(paid + sub.platformCut)})`);
  console.log("\nDONE. fixture:", fixturePda.toBase58());
}
main().catch((e) => { console.error("E2E FAILED:", e?.error?.errorMessage ?? e?.message ?? e); if (e?.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
