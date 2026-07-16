// Full step-0 verification against a devnet sample game_finalised fixture:
//  - fetch V3 proof for statKeys=1,2 (P1/P2 total goals) → home/away
//  - run txoracle.validate_stat_v3 on-chain (.view) with EqualTo predicates → expect TRUE
//  - tamper the score → expect FALSE (proves the predicate rejects a wrong score)
//  - measure serialized tx size (Solana limit 1232 bytes) for the forwarded proof
//  - compare Total(1,2) vs ETTotal(7001,7002) to see what "Total" means at finalisation

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { Txoracle } from "../types/txoracle";
import TxoracleJson from "../idl/txoracle.json";
import * as users from "../common/users";
import * as fs from "fs";

const AUTH_CACHE = "/tmp/txline-auth.json";
const j = (x: unknown) => JSON.stringify(x, (_, v) => (v?.type === "Buffer" ? "<buf>" : v), 2);

const parseHash = (h: any): number[] => {
  const raw = h?.hash ?? h;
  if (typeof raw === "string") return Array.from(raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64"));
  return Array.from(raw as ArrayLike<number>);
};
const mapProof = (p: any[]) => (p ?? []).map((n) => ({ hash: parseHash(n), isRightSibling: n.isRightSibling ?? false }));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program<Txoracle>(TxoracleJson as unknown as Txoracle, provider);
  const connection = provider.connection;
  const tokenMint = new PublicKey(process.env.TOKEN_MINT_ADDRESS!);
  const walletPath = process.env.ANCHOR_WALLET!;

  let cached: any = {};
  try { cached = JSON.parse(fs.readFileSync(AUTH_CACHE, "utf8")); } catch {}
  await users.setupUser("Keeper", walletPath, tokenMint, connection, program, 1, 4, [], cached.jwt, cached.apiToken);
  fs.writeFileSync(AUTH_CACHE, JSON.stringify({ jwt: users.authState.jwt, apiToken: users.authState.apiToken }));

  const fixtureId = Number(process.argv[2] ?? 18218149);
  let seq: number;
  if (process.argv[3]) {
    seq = Number(process.argv[3]);
    console.log(`fixture ${fixtureId}: using explicit seq ${seq}`);
  } else {
    const hist = (await users.apiClient.get(`/scores/historical/${fixtureId}`)).data;
    const recs: any[] = Array.isArray(hist) ? hist : (hist?.records ?? hist?.updates ?? []);
    const finals = recs.filter((r) => (r.action ?? r.Action) === "game_finalised" || (r.statusId ?? r.StatusId) === 100 || (r.period ?? r.Period) === 100);
    console.log(`fixture ${fixtureId}: ${recs.length} historical records, ${finals.length} finalised.`);
    if (finals[0]) console.log("first finalised record:\n", j(finals[0]));
    if (finals.length === 0) { console.log("no finalised record — pass an explicit seq as argv[3]"); return; }
    seq = Math.max(...finals.map((r) => Number(r.Seq ?? r.seq)));
  }

  const fetchV3 = async (keys: string) => (await users.apiClient.get(`/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${keys}`)).data;

  const val = await fetchV3("1,2");
  console.log("\nstat-validation-v3 keys:", Object.keys(val));
  console.log("summary:", j(val.summary));
  console.log("statsToProve:", j(val.statsToProve));

  const targetTs = Number(val.summary.updateStats.minTimestamp);
  const payload = {
    ts: new BN(targetTs),
    fixtureSummary: {
      fixtureId: new BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: parseHash(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof),
    mainTreeProof: mapProof(val.mainTreeProof),
    eventStatRoot: parseHash(val.eventStatRoot),
    leaves: val.statsToProve.map((l: any) => ({ stat: l.stat, statProof: mapProof(l.statProof) })),
    leafIndices: val.multiproof.indices,
    multiproofHashes: mapProof(val.multiproof.hashes),
  };
  const home = Number(payload.leaves[0].stat.value);
  const away = Number(payload.leaves[1].stat.value);
  console.log(`\n>>> FINAL SCORE Total(1,2): home=${home} away=${away}  (keys ${payload.leaves.map((l: any) => l.stat.key)}, periods ${payload.leaves.map((l: any) => l.stat.period)})`);

  const epochDay = Math.floor(targetTs / 86400000);
  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], program.programId);
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  const strat = (h: number, a: number) => ({
    geometricTargets: [],
    distancePredicate: null,
    discretePredicates: [
      { single: { index: 0, predicate: { threshold: h, comparison: { equalTo: {} } } } },
      { single: { index: 1, predicate: { threshold: a, comparison: { equalTo: {} } } } },
    ],
  });

  // Correct score → expect TRUE
  const ok = await program.methods.validateStatV3(payload, strat(home, away) as any)
    .accounts({ dailyScoresMerkleRoots: dailyScoresPda }).preInstructions([cuIx]).view();
  console.log(`\n>>> on-chain validate_stat_v3 (EqualTo ${home}-${away}):`, ok, ok === true ? "✓ PASS" : "✗");

  // Tampered score → expect FALSE
  const bad = await program.methods.validateStatV3(payload, strat(home + 1, away) as any)
    .accounts({ dailyScoresMerkleRoots: dailyScoresPda }).preInstructions([cuIx]).view();
  console.log(`>>> tampered (EqualTo ${home + 1}-${away}):`, bad, bad === false ? "✓ correctly REJECTED" : "✗ SHOULD BE FALSE");

  // tx-size spike: serialize the validate_stat_v3 tx (proxy for what player_perps forwards)
  const tx = await program.methods.validateStatV3(payload, strat(home, away) as any)
    .accounts({ dailyScoresMerkleRoots: dailyScoresPda }).preInstructions([cuIx]).transaction();
  tx.feePayer = provider.wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  console.log(`\n>>> serialized validate_stat_v3 tx size: ${size} bytes (Solana limit 1232). proof nodes: fixtureProof=${payload.fixtureProof.length} mainTreeProof=${payload.mainTreeProof.length} multiproof=${payload.multiproofHashes.length}`);

  // Total vs ETTotal
  try {
    const et = await fetchV3("7001,7002");
    console.log(">>> ETTotal(7001,7002) stats:", j(et.statsToProve?.map((s: any) => s.stat)));
  } catch (e: any) { console.log(">>> ETTotal fetch:", e?.response?.status, e?.response?.data); }
}

main().catch((e) => { console.error("FAILED:", e?.response?.status, e?.response?.data ?? e?.message ?? e); process.exit(1); });
