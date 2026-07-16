// TypeScript mirror of the Rust `engine` crate — same fixed-point integer math,
// using BigInt for exact u128-equivalent arithmetic. This is the ONE formula
// evaluated in three places: the on-chain program (Rust `engine`), the keeper
// (here), and the UI's live cash-out quote (player-perps-ui-spec.md §3). Keeping
// them byte-identical is why settlement, the keeper, and the live projection all
// agree. Ported from the tested reference `settleTrepa`
// (proximity-markets-simulator-trepa.html:521-611).

export const SCALE = 1_000_000n; // 6 decimals — matches USDC

export interface DistParams {
  p: bigint;      // fixed-point
  wGd: bigint;    // fixed-point
  wTg: bigint;    // fixed-point
  wCs: bigint;    // fixed-point
  capGd: number;  // integer goals
  capTg: number;  // integer goals
}

export const DEFAULT_DIST_PARAMS: DistParams = {
  p: 4n * SCALE,     // 4.0
  wGd: SCALE,        // 1.0
  wTg: SCALE / 2n,   // 0.5
  wCs: SCALE / 4n,   // 0.25
  capGd: 3,
  capTg: 4,
};

export interface PayoutParams {
  gamma: number;       // accuracy exponent (6)
  takeRateBps: number; // 2000 = 20%
  capMultiple: bigint; // 100n
}

export const DEFAULT_PAYOUT_PARAMS: PayoutParams = {
  gamma: 6,
  takeRateBps: 2000,
  capMultiple: 100n,
};

const outcomeSign = (gd: number): number => (gd > 0 ? 1 : gd < 0 ? -1 : 0);
const absU = (a: bigint): bigint => (a < 0n ? -a : a);
const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Market A distance D for a guess (gh,ga) vs actual (ah,aa). Fixed-point. */
export function distanceA(
  gh: number,
  ga: number,
  ah: number,
  aa: number,
  p: DistParams = DEFAULT_DIST_PARAMS,
): bigint {
  const gdGuess = gh - ga;
  const gdActual = ah - aa;
  const tgGuess = gh + ga;
  const tgActual = ah + aa;

  const correct = outcomeSign(gdGuess) === outcomeSign(gdActual) ? 1n : 0n;
  const dGd = minB(BigInt(Math.abs(gdGuess - gdActual)), BigInt(p.capGd));
  const dTg = minB(BigInt(Math.abs(tgGuess - tgActual)), BigInt(p.capTg));

  const csHomeGuess = ga === 0 ? 1n : 0n;
  const csHomeActual = aa === 0 ? 1n : 0n;
  const csAwayGuess = gh === 0 ? 1n : 0n;
  const csAwayActual = ah === 0 ? 1n : 0n;
  const csTerm = absU(csHomeGuess - csHomeActual) + absU(csAwayGuess - csAwayActual);

  return (1n - correct) * p.p + p.wGd * dGd + p.wTg * dTg + p.wCs * csTerm;
}

/** a = (1/(1+r))^gamma in fixed-point — no general pow(). */
export function accuracyWeight(r: bigint, gamma: number): bigint {
  const base = (SCALE * SCALE) / (SCALE + r);
  let result = SCALE;
  for (let i = 0; i < gamma; i++) result = (result * base) / SCALE;
  return result;
}

export interface Position {
  stake: bigint; // USDC base units
  d: bigint;     // fixed-point distance
}

export type VoidReason = "FewerThanTwo" | "AllEqualD";

export interface PositionOutcome {
  isWinner: boolean;
  a: bigint;
  gain: bigint;
  payout: bigint;
  capped: boolean;
}

export interface SettleResult {
  void: VoidReason | null;
  medianD: bigint;
  minD: bigint;
  countAtMin: number;
  coalitionMode: boolean;
  k: number;
  losersStakeSum: bigint;
  dividendPool: bigint;
  platformCut: bigint;
  undistributed: bigint;
  totalPool: bigint;
  outcomes: PositionOutcome[];
}

/** Full Trepa settlement — mirrors engine::settle exactly. */
export function settle(positions: Position[], params: PayoutParams = DEFAULT_PAYOUT_PARAMS): SettleResult {
  const n = positions.length;
  const totalPool = positions.reduce((s, p) => s + p.stake, 0n);

  const voidResult = (reason: VoidReason): SettleResult => ({
    void: reason,
    medianD: 0n,
    minD: 0n,
    countAtMin: 0,
    coalitionMode: false,
    k: 0,
    losersStakeSum: 0n,
    dividendPool: 0n,
    platformCut: 0n,
    undistributed: 0n,
    totalPool,
    outcomes: positions.map((p) => ({ isWinner: false, a: 0n, gain: 0n, payout: p.stake, capped: false })),
  });

  // 1. Void checks.
  if (n <= 1) return voidResult("FewerThanTwo");
  const ds = positions.map((p) => p.d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ds[0] === ds[n - 1]) return voidResult("AllEqualD");

  // 2. Best-coalition.
  const minD = ds[0];
  const countAtMin = positions.filter((p) => p.d === minD).length;
  const coalitionMode = countAtMin * 2 >= n;

  // 3. Median gate.
  const k = Math.floor((n + 1) / 2);
  const medianD = ds[k - 1];

  const outcomes: PositionOutcome[] = positions.map((p) => ({
    isWinner: coalitionMode ? p.d === minD : p.d < medianD,
    a: 0n,
    gain: 0n,
    payout: 0n,
    capped: false,
  }));

  // 4. Accuracy weights (winners only).
  positions.forEach((p, i) => {
    if (outcomes[i].isWinner) {
      const r = medianD === 0n ? 0n : (p.d * SCALE) / medianD;
      outcomes[i].a = accuracyWeight(r, params.gamma);
    }
  });

  // 5. Dividend pool.
  const losersStakeSum = positions.filter((_, i) => !outcomes[i].isWinner).reduce((s, p) => s + p.stake, 0n);
  const dividendPool = (losersStakeSum * (10_000n - BigInt(params.takeRateBps))) / 10_000n;

  // 6. Cap + water-fill.
  const winners = outcomes.map((o, i) => (o.isWinner ? i : -1)).filter((i) => i >= 0);
  const capped = new Array(n).fill(false);
  let remaining = dividendPool;
  let undistributed = 0n;

  for (let round = 0; round < 10; round++) {
    const uncapped = winners.filter((i) => !capped[i]);
    const sumA = uncapped.reduce((s, i) => s + outcomes[i].a, 0n);
    if (uncapped.length === 0 || sumA === 0n) {
      undistributed = remaining;
      remaining = 0n;
      break;
    }
    const alpha = (remaining * SCALE) / sumA;
    let anyCapped = false;
    for (const i of uncapped) {
      const naive = (alpha * outcomes[i].a) / SCALE;
      const cap = positions[i].stake * params.capMultiple;
      if (naive > cap) {
        outcomes[i].gain = cap;
        outcomes[i].capped = true;
        capped[i] = true;
        remaining -= cap;
        anyCapped = true;
      }
    }
    if (!anyCapped) {
      for (const i of uncapped) outcomes[i].gain = (alpha * outcomes[i].a) / SCALE;
      remaining = 0n;
      break;
    }
  }
  if (remaining > undistributed) undistributed = remaining;

  // 7. Payouts + exact conservation (platform_cut absorbs take + dust + residual).
  let winnersGainSum = 0n;
  for (const i of winners) {
    winnersGainSum += outcomes[i].gain;
    outcomes[i].payout = positions[i].stake + outcomes[i].gain;
  }
  const platformCut = losersStakeSum - winnersGainSum;

  return {
    void: null,
    medianD,
    minD,
    countAtMin,
    coalitionMode,
    k,
    losersStakeSum,
    dividendPool,
    platformCut,
    undistributed,
    totalPool,
    outcomes,
  };
}

/** Σ payout + platform_cut == total_pool — the conservation invariant. */
export function conserves(r: SettleResult): boolean {
  const paid = r.outcomes.reduce((s, o) => s + o.payout, 0n);
  return paid + r.platformCut === r.totalPool;
}
