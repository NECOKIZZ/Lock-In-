# How the Settlement Proof Works (and how to show it in a demo)

Player Perps never trusts anyone — not the keeper, not our own server — to say
what the final score was. The score enters the program **only** through a
Merkle proof that is verified **on-chain** against data that TxLine (TxODDS)
itself publishes on-chain. This doc explains the proof structure bottom-up,
then gives you a demo-video script with the exact things to point the camera at.

## 1. The chain of custody

```
 real match
    │  TxLine's feed observers record every event (goal, card, finalisation…)
    ▼
 score records  ──►  each day, TxLine hashes ALL of that day's records into a
 (off-chain API)     Merkle tree and publishes ONLY the root on Solana:
                     the `daily_scores_roots` PDA (one per UTC epoch-day)
    │
    │  our keeper asks the API for a *proof* for one specific record
    ▼
 StatValidationInputV3  = the final-score leaves + every sibling hash needed
                          to recompute the path from leaf → daily root
    │
    │  keeper submits it to OUR program (it cannot alter it — see §3)
    ▼
 player_perps.validate_score
    ├─ re-derives the root PDA from the proof's own timestamp (seeds pinned)
    ├─ requires stat period == 100  (game_finalised, not an in-play snapshot)
    ├─ requires statKey 1 & 2       (full-time total goals, home & away)
    └─ CPI → txoracle.validate_stat_v3
              recomputes leaf-hash → … → root and compares against the
              on-chain daily root. Returns 1 = proven, else the tx REVERTS.
    ▼
 fixture.actual_home / actual_away  — now trustlessly stored on-chain
    ▼
 submit_settlement — program re-derives every staker's distance D from that
 stored score, re-checks the median order-statistic and the conservation
 invariant Σpayouts + platform_cut == total_pool before accepting.
```

## 2. What's inside `StatValidationInputV3`

The proof object the keeper fetches (`/scores/stat-validation-v3?fixtureId=…&seq=…&statKeys=1,2`):

| field | what it is |
|---|---|
| `leaves[]` | the stats being proven — `{key:1, value:home, period:100}` and `{key:2, value:away, period:100}` |
| `leafIndices`, `multiproofHashes` | multiproof for the stat leaves inside the record's stat tree |
| `eventStatRoot` | root of that stat tree |
| `fixtureSummary` | the fixture's identity + update counts (binds the proof to fixture id) |
| `fixtureProof` | path from this record up through the fixture's sub-tree |
| `mainTreeProof` | path from the fixture sub-tree up to the **daily root** |
| `ts` | record timestamp — determines which day's root PDA to check against |

The stat keys matter: **1/2 = whole-match total goals** (includes extra time,
*excludes* penalty shootouts — those are separate 6000-series keys), and
**period 100** is TxLine's `game_finalised` marker covering every finish type
(regulation / ET / pens / abandoned). So "final score" is unambiguous.

## 3. Why the keeper can't cheat

- **Wrong score** → the leaf hashes change → recomputed root ≠ on-chain root →
  CPI returns 0 → `ScoreProofRejected`, transaction reverts. We proved this
  live: submitting a tampered 3-1 instead of the true 2-1 fails on-chain.
- **Wrong root account** → it can't pick one: `daily_scores_merkle_roots` is an
  Anchor `seeds=` constraint derived from the *proof's own timestamp* under the
  *txoracle program id* — the address is forced, not supplied.
- **Wrong oracle program** → `txoracle_program` is pinned by `address =` to the
  hardcoded network constant.
- **In-play snapshot passed off as final** → `period == 100` requirement.
- **Wrong payouts after a correct score** → `submit_settlement` recomputes each
  D on-chain and enforces median + conservation; a bad submission reverts.

Worst case for a malicious/buggy keeper is a market that *doesn't* settle
(→ Void → everyone refunded) — never a wrong payout.

## 4. What to show in the demo video

Yes — you have **real transaction hashes**, and the money shot is the
**explorer's "Instruction Logs" view of the `validate_score` tx**, because the
CPI into TxLine's program is visible right in the log tree.

Suggested 60–90s sequence:

1. **The app** (`app.html`): click a settled market chip (e.g. the 3-1 sample,
   or FRA–ESP which finished 0-2 for real). The **"⛓ Settlement proof"** panel
   appears with the final score, the feed record (`game_finalised · seq …`),
   and two clickable tx links.
2. **Click "score proof tx"** → Solana Explorer opens. Scroll to
   **Program Instruction Logs** and point at this structure:
   ```
   player_perps (6krd…mE26)  Instruction: ValidateScore
     └─ txoracle (6pW6…yP2J)  Instruction: ValidateStatV3
        Program return: … AQ==          ← base64 for 0x01 = TRUE, proof valid
   ```
   Narration: *"our program doesn't read the score from us — it hands the
   Merkle proof to the oracle's own on-chain program, which checks it against
   the root the oracle published for that day. The `AQ==` return is the
   proof passing."*
3. **Click "settlement tx"** → show `SubmitSettlement` and say the program
   re-derives every player's distance from the proven score and refuses any
   settlement where the payouts don't sum exactly to the pool.
4. Optionally click the **market account** link and show the fixture PDA state.

Live devnet artifacts you can use right now (also in `app/ui/fixtures.json`):

| market | what happened | validate tx | settle tx |
|---|---|---|---|
| 18222446 (3-1) | settled, winner claimed $90 of a $100 pool | `3g81NgBM…` | `f7Pffhm9…` (SubmitSettlement) |
| FRA–ESP 18237038 (0-2, real match) | voided (no stakers), refund path | `3Q4nUPuB…` | `g7HYc96p…` (ComputeDistancesBatch → Void) |

Full signatures are in `app/ui/fixtures.json` (`validateSig` / `settleSig`);
explorer URL pattern: `https://explorer.solana.com/tx/<sig>?cluster=devnet`.

A good backup shot: `keeper/e2e/probe-validate.ts` output showing the
**tamper test** — same proof, score changed to 3-1, on-chain validation
returns FALSE.

## 5. Where things live

- proof fetch + shaping: `keeper/src/txline.ts` (`fetchValidatedFinalScore`)
- on-chain verification: `programs/player_perps/src/instructions/lifecycle.rs`
  (`validate_score`) → CPI declared via vendored IDL `programs/player_perps/idls/txoracle.json`
- settlement re-check: `programs/player_perps/src/instructions/fast_path.rs`
- automated pipeline: `keeper/e2e/lister.ts` (list) + `keeper/e2e/monitor.ts`
  (lock → prove → settle), registry in `app/ui/fixtures.json`
- sample raw proof JSON (for slides): `app/ui/proof-sample.json`
