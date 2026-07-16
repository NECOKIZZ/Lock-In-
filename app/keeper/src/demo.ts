// Runs the Solana build spec §7 worked example through the TS engine and asserts
// the exact ledger — the same numbers the Rust `engine` crate's tests prove.
// Verifiable right now with zero install:  node src/demo.ts
//
// Actual score 2-1, five stakers. Expected: median D = 1.75, winners A & C,
// payout A = $135.91, payout C = $42.09, platform take $22.00, conservation $200.

import { DEFAULT_DIST_PARAMS, DEFAULT_PAYOUT_PARAMS, distanceA, settle, conserves } from "./engine.ts";
import type { Position } from "./engine.ts";

const SCALE = 1_000_000n;
const usdc = (dollars: number): bigint => BigInt(dollars) * SCALE;
const fmt = (base: bigint): string => `$${(Number(base) / 1e6).toFixed(2)}`;
const cents = (base: bigint): bigint => (base + 5_000n) / 10_000n;

const ACTUAL_H = 2;
const ACTUAL_A = 1;

const stakers = [
  { name: "A", gh: 2, ga: 1, stake: 50 },
  { name: "C", gh: 3, ga: 1, stake: 40 },
  { name: "B", gh: 2, ga: 0, stake: 30 },
  { name: "D", gh: 1, ga: 1, stake: 20 },
  { name: "E", gh: 1, ga: 2, stake: 60 },
];

const positions: Position[] = stakers.map((s) => ({
  stake: usdc(s.stake),
  d: distanceA(s.gh, s.ga, ACTUAL_H, ACTUAL_A, DEFAULT_DIST_PARAMS),
}));

const res = settle(positions, DEFAULT_PAYOUT_PARAMS);

console.log(`\nPlayer Perps — Market A settlement (actual ${ACTUAL_H}-${ACTUAL_A})`);
console.log(`median D = ${(Number(res.medianD) / 1e6).toFixed(2)}   coalition=${res.coalitionMode}   k=${res.k}\n`);
console.log("staker  guess  stake     D      result   payout      ROI");
console.log("-".repeat(62));
stakers.forEach((s, i) => {
  const o = res.outcomes[i];
  const d = (Number(positions[i].d) / 1e6).toFixed(2);
  const roi = o.payout > 0n ? (Number(o.payout) / Number(positions[i].stake)).toFixed(2) + "x" : "—";
  const result = o.isWinner ? "WIN " : "lose";
  console.log(
    `  ${s.name}     ${s.gh}-${s.ga}   ${fmt(positions[i].stake).padStart(7)}  ${d.padStart(5)}   ${result}   ${fmt(o.payout).padStart(9)}  ${roi.padStart(6)}`,
  );
});
const paid = res.outcomes.reduce((sum, o) => sum + o.payout, 0n);
console.log("-".repeat(62));
console.log(`platform take ${fmt(res.platformCut)}   |   Σ payout ${fmt(paid)} + take ${fmt(res.platformCut)} = ${fmt(paid + res.platformCut)}`);

// ---- assertions (the spec §7 contract) ----
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`\n✗ FAIL: ${msg}`);
    process.exit(1);
  }
}
assert(res.void === null, "round should not be void");
assert(res.medianD === 1_750_000n, "median D must be 1.75");
assert(!res.coalitionMode, "no coalition");
assert(res.outcomes[0].isWinner && res.outcomes[1].isWinner, "A and C win");
assert(!res.outcomes[2].isWinner && !res.outcomes[3].isWinner && !res.outcomes[4].isWinner, "B, D, E lose");
assert(cents(res.outcomes[0].payout) === 13_591n, "payout A = $135.91");
assert(cents(res.outcomes[1].payout) === 4_209n, "payout C = $42.09");
assert(res.outcomes[2].payout === 0n, "payout B = $0");
assert(cents(res.platformCut) === 2_200n, "platform take = $22.00");
assert(paid + res.platformCut === usdc(200), "exact conservation to $200");
assert(conserves(res), "conservation invariant holds");

console.log("\n✓ All spec §7 assertions passed — TS keeper matches the Rust engine.\n");
