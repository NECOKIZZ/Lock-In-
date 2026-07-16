// Monitor E2E setup: list an ALREADY-FINALISED devnet fixture with a short lock
// window and put three real stakes on it, so a monitor.ts pass can prove the
// full path (lock → validate via real txoracle CPI → submit_settlement) end to
// end. Optionally also stakes on a future market (STAKE_FIXTURE=<id>) so its
// real finalisation later settles a non-empty pool.
//
// Staker keypairs are saved to app/keeper/.keys/stakers-<fixtureId>.json so
// payouts remain claimable.
//
//   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... TOKEN_MINT_ADDRESS=... \
//   npx tsx examples/devnet/monitor-e2e-setup.ts [fixtureId] [lockDelaySec]

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createMintToInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import PpIdl from "./player_perps.idl.json";
import { DEFAULT_DIST_PARAMS, DEFAULT_PAYOUT_PARAMS } from "./engine.ts";
import * as fs from "fs";

const UI_DIR = process.env.HOME + "/Player and match score perps/app/ui";
const KEYS_DIR = process.env.HOME + "/Player and match score perps/app/keeper/.keys";
const FIXTURE_ID = Number(process.argv[2] ?? 18222446); // devnet sample, finalised 3-1
const LOCK_DELAY = Number(process.argv[3] ?? 90);
const usdc = (d: number) => BigInt(d) * 1_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STAKERS = [
  { name: "P1", gh: 3, ga: 1, stake: 50 }, // exact
  { name: "P2", gh: 2, ga: 1, stake: 30 },
  { name: "P3", gh: 0, ga: 0, stake: 20 },
];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const keeper = (provider.wallet as anchor.Wallet).payer;
  const pp = new Program(PpIdl as anchor.Idl, provider);

  const cfg = fs.readFileSync(`${UI_DIR}/config.js`, "utf8");
  const usdcMint = new PublicKey(cfg.match(/USDC_MINT: "(\w+)"/)![1]);
  const faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(`[${cfg.match(/FAUCET_SECRET: \[([\d,]+)\]/)![1]}]`)));

  const idBuf = new BN(FIXTURE_ID).toArrayLike(Buffer, "le", 8);
  const [fixturePda] = PublicKey.findProgramAddressSync([Buffer.from("fixture"), idBuf], pp.programId);
  const escrow = getAssociatedTokenAddressSync(usdcMint, fixturePda, true);

  // list with a short lock window (only if it's a fresh fixture)
  const existing = await conn.getAccountInfo(fixturePda);
  const lockTime = Math.floor(Date.now() / 1000) + LOCK_DELAY;
  if (!existing) {
    const D = DEFAULT_DIST_PARAMS, P = DEFAULT_PAYOUT_PARAMS;
    await pp.methods.initializeFixture(new BN(FIXTURE_ID), new BN(lockTime),
      { p: new BN(D.p), wGd: new BN(D.wGd), wTg: new BN(D.wTg), wCs: new BN(D.wCs), capGd: D.capGd, capTg: D.capTg },
      { gamma: P.gamma, takeRateBps: P.takeRateBps, capMultiple: new BN(P.capMultiple) })
      .accountsStrict({ authority: keeper.publicKey, fixture: fixturePda, usdcMint, escrow,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`✓ listed ${FIXTURE_ID} lock in ${LOCK_DELAY}s — ${fixturePda.toBase58()}`);
    await sleep(1500);
  } else console.log(`fixture ${FIXTURE_ID} already on-chain: ${fixturePda.toBase58()}`);

  // fund + mint + stake, batched for the public RPC
  const kps = STAKERS.map(() => Keypair.generate());
  fs.writeFileSync(`${KEYS_DIR}/stakers-${FIXTURE_ID}.json`, JSON.stringify(kps.map((k) => Array.from(k.secretKey))));
  const atas = kps.map((kp) => getAssociatedTokenAddressSync(usdcMint, kp.publicKey));

  const setupTx = new Transaction();
  kps.forEach((kp, i) => {
    setupTx.add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: kp.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }));
    setupTx.add(createAssociatedTokenAccountInstruction(keeper.publicKey, atas[i], kp.publicKey, usdcMint));
    setupTx.add(createMintToInstruction(usdcMint, atas[i], faucet.publicKey, usdc(STAKERS[i].stake)));
  });
  await sendAndConfirmTransaction(conn, setupTx, [keeper, faucet]);
  console.log("✓ funded + minted", STAKERS.length, "stakers");
  await sleep(1500);

  for (let i = 0; i < STAKERS.length; i++) {
    const s = STAKERS[i], kp = kps[i];
    const [posPda] = PublicKey.findProgramAddressSync([Buffer.from("stake"), idBuf, kp.publicKey.toBuffer()], pp.programId);
    await pp.methods.stake(s.gh, s.ga, new BN(usdc(s.stake)))
      .accountsStrict({ staker: kp.publicKey, fixture: fixturePda, position: posPda, stakerUsdc: atas[i], escrow, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([kp]).rpc();
    console.log(`✓ stake ${s.name} ${s.gh}-${s.ga} $${s.stake}`);
    await sleep(1500);
  }

  // register in fixtures.json so monitor.ts picks it up
  const regPath = `${UI_DIR}/fixtures.json`;
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  if (!reg.markets.some((m: any) => m.fixtureId === FIXTURE_ID)) {
    reg.markets.push({
      fixtureId: FIXTURE_ID, pda: fixturePda.toBase58(), escrow: escrow.toBase58(),
      home: "Monitor", away: "Test", homeId: 0, awayId: 0, competition: "Devnet sample (finalised)",
      kickoff: lockTime * 1000, lockTime, listedAt: Date.now(), state: "Open",
      stakerCount: STAKERS.length, totalPool: STAKERS.reduce((s, x) => s + x.stake, 0) * 1e6,
    });
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 1));
    console.log("✓ registered in fixtures.json");
  }
  console.log(`ready — lock at ${new Date(lockTime * 1000).toISOString()}; run monitor.ts after that.`);
}
main().catch((e) => { console.error("SETUP FAILED:", e?.error?.errorMessage ?? e?.message ?? e); if (e?.logs) console.error(e.logs.slice(-8).join("\n")); process.exit(1); });
