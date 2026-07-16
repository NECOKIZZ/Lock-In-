import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import PpIdl from "./player_perps.idl.json";
import { settle, distanceA, DEFAULT_DIST_PARAMS, DEFAULT_PAYOUT_PARAMS } from "./engine.ts";
import * as fs from "fs";
const FIXTURE_ID = 18222446;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const provider = anchor.AnchorProvider.env(); anchor.setProvider(provider);
  const pp = new Program(PpIdl as anchor.Idl, provider);
  const cfg = fs.readFileSync(process.env.HOME + "/Player and match score perps/app/ui/config.js", "utf8");
  const usdcMint = new PublicKey(cfg.match(/USDC_MINT: "(\w+)"/)![1]);
  const kps: Keypair[] = JSON.parse(fs.readFileSync(process.env.HOME + `/Player and match score perps/app/keeper/.keys/stakers-${FIXTURE_ID}.json`, "utf8")).map((s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s)));
  const idBuf = new BN(FIXTURE_ID).toArrayLike(Buffer, "le", 8);
  const [fixturePda] = PublicKey.findProgramAddressSync([Buffer.from("fixture"), idBuf], pp.programId);
  const escrow = getAssociatedTokenAddressSync(usdcMint, fixturePda, true);
  const fx = await (pp.account as any).fixture.fetch(fixturePda);
  console.log("fixture status:", Object.keys(fx.status)[0], "| actual", `${fx.actualHome}-${fx.actualAway}`, "| pool", fx.totalPool.toString(), "| platform_cut", fx.platformCut.toString(), "| median_d", fx.medianD.toString());

  // engine cross-check
  const guesses = [{gh:3,ga:1,stake:50_000_000n},{gh:2,ga:1,stake:30_000_000n},{gh:0,ga:0,stake:20_000_000n}];
  const ep = guesses.map((g) => ({ stake: g.stake, d: distanceA(g.gh, g.ga, fx.actualHome, fx.actualAway, DEFAULT_DIST_PARAMS) }));
  const res = settle(ep, DEFAULT_PAYOUT_PARAMS);
  console.log("engine says: medianD", res.medianD, "cut", res.platformCut, "payouts", res.outcomes.map((o: any) => o.payout.toString()).join(","));

  let sum = 0n;
  for (let i = 0; i < kps.length; i++) {
    const kp = kps[i];
    const [posPda] = PublicKey.findProgramAddressSync([Buffer.from("stake"), idBuf, kp.publicKey.toBuffer()], pp.programId);
    const pos = await (pp.account as any).stakePosition.fetch(posPda);
    const payout = BigInt(pos.payoutAmount.toString());
    sum += payout;
    const enginePayout = res.outcomes[i].payout;
    console.log(`P${i+1} guess ${pos.guessHome}-${pos.guessAway} payout ${payout} (engine ${enginePayout}) ${payout === enginePayout ? "MATCH" : "MISMATCH"}`);
    if (payout > 0n && !pos.claimed) {
      const ata = getAssociatedTokenAddressSync(usdcMint, kp.publicKey);
      await pp.methods.claimPayout().accountsStrict({ staker: kp.publicKey, fixture: fixturePda, position: posPda, escrow, stakerUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).signers([kp]).rpc();
      await sleep(1200);
      const bal = (await getAccount(provider.connection, ata)).amount;
      console.log(`  ✓ claimed — ATA balance now ${bal} ($${Number(bal)/1e6})`);
    }
  }
  console.log("conservation:", sum + BigInt(fx.platformCut.toString()) === BigInt(fx.totalPool.toString()) ? "✓ Σpayout+cut == pool" : "✗ FAIL");
}
main().catch((e) => { console.error("CLAIM FAILED:", e?.error?.errorMessage ?? e?.message ?? e); process.exit(1); });
