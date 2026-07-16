# Player Perps — Multichain Plan (v1.0)

## 0. The TxLine data finding, and why it changes chain sequencing

TxLine's cryptographic proof system (Solana Merkle roots) covers team-level stats only (goals/cards/corners, keys 1-8). Player-level stats exist but are off-chain-only. This isn't just a Market B footnote — it changes the architecture story for going multichain, because of where TxLine itself lives.

**TxLine is a Solana program.** Its subscribe/activate/validation flow (`programId`, on-chain Merkle roots, `validateStatV2`) all runs on Solana. That means for Market A specifically, launching on Solana first isn't just "the hackathon requires it" — it's the only chain where your escrow program can verify the final scoreline directly against TxLine's on-chain state via a same-chain cross-program invocation (CPI), with zero cross-chain trust assumptions. Nothing needs to be bridged, relayed, or attested — your settlement instruction calls TxLine's validation instruction in the same transaction context. That's the cleanest possible trust story, and it's Solana-only.

## 1. Phase 1 — Solana only (this is the July 19 build)

```
User stakes (guess + USDC) → Escrow PDA (Anchor program)
Match plays out → TxLine posts team-level stats, Merkle-anchored on-chain
At lock/settlement → Escrow program CPIs into TxLine's program, validates
                       final score against the on-chain Merkle root
                    → Runs the Trepa settlement engine (median gate,
                       accuracy weight, cap/water-fill) using the
                       validated score
                    → Pays out directly from the escrow PDA
```

Market A gets the full trustless story end-to-end, same-chain, no oracle bridge. Market B runs the same engine but reads from TxLine's off-chain `PlayerStats` feed instead of the on-chain Merkle root — functionally fine, just be explicit in your own docs that it's a different trust tier (§0 above), and consider having your backend post the player-stat inputs on-chain as an event log at settlement time purely for auditability, even though it's not Merkle-proven the way team stats are.

**What actually needs building for the 19th:** one Anchor program (escrow + settlement, single chain, no bridge logic at all), the CPI call into TxLine's validation, and the settlement engine you already have ported into Rust (or kept off-chain in a keeper that posts the result on-chain — faster to ship, slightly weaker trust story; your call given the timeline). Don't build any of Phase 2 before this works end-to-end on one chain.

## 2. Phase 2 — expanding via Circle infra

The principle from your own earlier research holds: **only the escrow layer changes per chain.** The settlement engine, the `D`/`S` formulas, the median-rule payout logic, the TxLine data consumption — none of that is chain-specific. What changes is where the money sits and how it gets there.

- **Circle CCTP** — native USDC burn-and-mint across chains, not a wrapped/bridged asset. Use this so a user staking from Arbitrum, Base, or Avalanche/Arc ends up with real USDC in whichever chain's escrow is actually settling the market, instead of a synthetic bridged token.
- **Circle Gateway** — unified USDC balance across chains. A user deposits once and that balance is usable across supported chains without a manual bridge step per market they enter — matters for onboarding, since most people won't want to bridge manually before every stake.
- **Circle Paymaster** — gas sponsorship. Lets someone stake without holding the native gas token of whatever chain the escrow happens to live on. This is a real UX unlock for a consumer sports product where most users aren't crypto-native.

**The asymmetry you need to design around:** Solana's escrow gets same-chain, CPI-verified settlement against TxLine's Merkle root. An EVM-side escrow (Arbitrum, Base, Avalanche/Arc) can't do that same trick — TxLine's proof lives on Solana, not on the EVM chain. So an EVM escrow has two honest options:

1. **Relay the Solana-verified result cross-chain** via a message-passing bridge (Wormhole is the natural fit given TxLine's own Solana anchoring) — settlement still ultimately traces back to TxLine's on-chain proof, just with an extra hop and an extra trust assumption (the bridge itself).
2. **Trust a keeper/backend attestation** — your own backend reads TxLine's validated Solana state and signs the result for the EVM escrow to act on. Faster to build, weaker trust story (you're now the oracle, not TxLine's on-chain proof directly).

Neither is wrong, but don't market EVM-chain settlement as carrying the identical trustless guarantee Solana gets natively — it doesn't, unless you build the full cross-chain proof relay, which is real engineering, not a config change.

## 3. Build order

1. **Now → July 19:** Solana only. Escrow + Trepa engine + CPI into TxLine. Market A fully trustless end-to-end; Market B running on the off-chain player-stat feed with the trust-tier caveat documented, not hidden.
2. **Post-hackathon, v1.5:** add Circle CCTP/Gateway/Paymaster purely as a *deposit/withdrawal* convenience layer — users on other chains can fund a Solana-settled market without manually bridging, while settlement itself stays on Solana. This gets you multichain *reach* without touching the trust model at all — lowest-risk expansion step.
3. **v2:** actual per-chain escrow + settlement (the harder step in §2) — only once there's demand from users who specifically want to stay non-custodial to their home chain through settlement, not just funding.

Step 2 is the one I'd actually prioritize once the hackathon core ships — it gets you "multichain" in the way that matters for user acquisition (stake from anywhere) with none of the cross-chain trust engineering that step 3 requires.
