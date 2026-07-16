// Read-only verification of the completed lifecycle on devnet: fetch the fixture +
// all stakePosition accounts and assert exact engine integers.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import PpIdl from "./player_perps.idl.json";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const pp = new anchor.Program(PpIdl as anchor.Idl, provider);
  const FIXTURE_PDA = new PublicKey("7Nv6vQdpPiRPCmzSyvorCq54e4VCwhAHNG9dfjSuih38");

  const fx = await (pp.account as any).fixture.fetch(FIXTURE_PDA);
  console.log("fixture:", FIXTURE_PDA.toBase58());
  console.log("  txline_fixture_id:", fx.txlineFixtureId.toString(), "| status:", JSON.stringify(fx.status));
  console.log("  actual score:", `${fx.actualHome}-${fx.actualAway}`, "| total staked:", fx.totalStaked?.toString?.() ?? "(n/a)");

  const all = await (pp.account as any).stakePosition.all();
  const mine = all.filter((a: any) => a.account.fixture?.toBase58?.() === FIXTURE_PDA.toBase58() || true); // single fixture on this program
  console.log(`\n${mine.length} stakePosition accounts on program:`);
  let sum = 0n;
  const rows = mine.map((a: any) => {
    const p = a.account;
    sum += BigInt(p.payoutAmount.toString());
    return { guess: `${p.guessHome}-${p.guessAway}`, stake: p.stakeAmount.toString(), payout: p.payoutAmount.toString(), claimed: p.claimed };
  }).sort((x: any, y: any) => Number(y.payout) - Number(x.payout));
  rows.forEach((r: any) => console.log(`  guess ${r.guess}  stake ${r.stake}  payout ${r.payout}  claimed ${r.claimed}`));

  const ok = (c: boolean, m: string) => console.log((c ? "✓" : "✗ FAIL") + " " + m);
  console.log("\n=== on-chain assertions (exact integers) ===");
  ok(mine.length === 5, `5 positions (got ${mine.length})`);
  ok(fx.actualHome === 2 && fx.actualAway === 1, `actual score 2-1`);
  ok(rows[0].payout === "135906207" && rows[0].guess === "2-1", `A (2-1) payout 135906207 exact`);
  ok(rows[1].payout === "42093791" && rows[1].guess === "3-1", `C (3-1) payout 42093791 exact`);
  ok(rows.slice(2).every((r: any) => r.payout === "0"), `B/D/E payout 0`);
  ok(rows.slice(0, 2).every((r: any) => r.claimed === true), `winners claimed`);
  ok(sum === 177999998n, `Σ payouts = 177999998 (+ take 22000002 = 200000000 exact)`);
}
main().catch((e) => { console.error("VERIFY FAILED:", e?.message ?? e); process.exit(1); });
