//! Full batched, resumable on-chain settlement pipeline (Solana build spec §5.4).
//!
//! Settlement is a *global* aggregate (median, water-fill) over every staker, but
//! Solana caps compute units and accounts per transaction — so it can't be one
//! instruction once there are real staker counts. Each phase here processes a
//! slice of `StakePosition`s via `remaining_accounts` and advances accumulators
//! stored on the `Fixture`, so any keeper (or the frontend) can drive it forward
//! with repeated calls. Every step uses the same `engine` math as the fast path
//! and the keeper, so all three agree by construction.
//!
//! Phases: `compute_distances_batch` → `verify_median_candidate` (batched) →
//! `finalize_median` → `settle_batch` → `compute_payouts_batch` (repeat until
//! `Settled`).

use anchor_lang::prelude::*;

use crate::errors::PerpError;
use crate::state::{Fixture, FixtureStatus, StakePosition};

#[derive(Accounts)]
pub struct PipelineBatch<'info> {
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [b"fixture", &fixture.txline_fixture_id.to_le_bytes()],
        bump = fixture.bump,
    )]
    pub fixture: Account<'info, Fixture>,
    // StakePositions for this batch are passed as remaining_accounts.
}

/// Borrow a remaining account as a `StakePosition`, verify it belongs to the
/// fixture, hand it to `f`, then serialize the mutation back.
fn with_position<'info, R>(
    acc: &AccountInfo<'info>,
    fixture_key: Pubkey,
    f: impl FnOnce(&mut StakePosition) -> Result<R>,
) -> Result<R> {
    let mut data = acc.try_borrow_mut_data()?;
    let mut pos = StakePosition::try_deserialize(&mut &data[..])?;
    require_keys_eq!(pos.fixture, fixture_key, PerpError::WrongFixture);
    let out = f(&mut pos)?;
    pos.try_serialize(&mut &mut data[..])?;
    Ok(out)
}

// --------------------------------------------------------------------------
// Phase 2 — compute_distances_batch
// --------------------------------------------------------------------------

pub fn compute_distances_batch(ctx: Context<PipelineBatch>) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    // Status stays ScoreValidated across every distance batch; it only flips to
    // DistancesComputed once the final batch completes below.
    require!(f.status == FixtureStatus::ScoreValidated, PerpError::WrongStatus);

    // Streaming min/max start values, set once at the first batch.
    if f.distances_computed_count == 0 {
        f.running_min_d = u64::MAX;
        f.running_max_d = 0;
        f.running_count_at_min = 0;
    }

    let batch = ctx.remaining_accounts.len() as u16;
    require!(
        f.distances_computed_count + batch <= f.staker_count,
        PerpError::BatchOverflow
    );

    let dp = f.dist_params.to_engine();
    let (ah, aa) = (f.actual_home, f.actual_away);
    let fixture_key = f.key();

    for acc in ctx.remaining_accounts.iter() {
        let d = with_position(acc, fixture_key, |pos| {
            let d = engine::distance_a(pos.guess_home, pos.guess_away, ah, aa, &dp);
            pos.distance_d = d;
            Ok(d)
        })?;

        if d < f.running_min_d {
            f.running_min_d = d;
            f.running_count_at_min = 1;
        } else if d == f.running_min_d {
            f.running_count_at_min += 1;
        }
        if d > f.running_max_d {
            f.running_max_d = d;
        }
    }
    f.distances_computed_count += batch;

    // Finished computing every distance?
    if f.distances_computed_count == f.staker_count {
        // Void: fewer than 2 stakers, or every staker on the exact same D.
        if f.staker_count <= 1 || f.running_min_d == f.running_max_d {
            f.status = FixtureStatus::Void;
            return Ok(());
        }
        f.coalition_mode = (f.running_count_at_min as usize) * 2 >= f.staker_count as usize;
        f.status = FixtureStatus::DistancesComputed;
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Phase 3 — verify_median_candidate (batched) + finalize_median
// --------------------------------------------------------------------------

pub fn verify_median_candidate(ctx: Context<PipelineBatch>, candidate: u64) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    require!(f.status == FixtureStatus::DistancesComputed, PerpError::WrongStatus);

    // First batch of a fresh attempt: latch the candidate and reset tallies.
    if f.median_verify_count == 0 {
        f.median_candidate = candidate;
        f.median_count_below = 0;
        f.median_count_equal = 0;
    }
    require!(candidate == f.median_candidate, PerpError::BadMedian);

    let batch = ctx.remaining_accounts.len() as u16;
    require!(f.median_verify_count + batch <= f.staker_count, PerpError::BatchOverflow);

    let fixture_key = f.key();
    let cand = f.median_candidate;
    let (mut below, mut equal) = (0u16, 0u16);
    for acc in ctx.remaining_accounts.iter() {
        let d = with_position(acc, fixture_key, |pos| Ok(pos.distance_d))?;
        if d < cand {
            below += 1;
        } else if d == cand {
            equal += 1;
        }
    }
    f.median_count_below += below;
    f.median_count_equal += equal;
    f.median_verify_count += batch;
    Ok(())
}

pub fn finalize_median(ctx: Context<PipelineBatch>) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    require!(f.status == FixtureStatus::DistancesComputed, PerpError::WrongStatus);
    require!(f.median_verify_count == f.staker_count, PerpError::PhaseIncomplete);

    // Order statistic: the k-th smallest D equals the candidate iff
    // below < k <= below + equal.  k = floor((N+1)/2).
    let k = ((f.staker_count as usize) + 1) / 2;
    let below = f.median_count_below as usize;
    let equal = f.median_count_equal as usize;
    if below < k && k <= below + equal {
        f.median_d = f.median_candidate;
        f.median_verified = true;
        f.status = FixtureStatus::MedianVerified;
    } else {
        // Deterministic public data — this only happens on a keeper arithmetic
        // error. Reset the tallies so it can resubmit a corrected candidate.
        f.median_verify_count = 0;
        f.median_count_below = 0;
        f.median_count_equal = 0;
        return err!(PerpError::BadMedian);
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Phase 4 — settle_batch (classify winners, accumulate a_i and losers' stakes)
// --------------------------------------------------------------------------

pub fn settle_batch(ctx: Context<PipelineBatch>) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    require!(f.status == FixtureStatus::MedianVerified, PerpError::WrongStatus);

    let batch = ctx.remaining_accounts.len() as u16;
    require!(f.winners_processed_count + batch <= f.staker_count, PerpError::BatchOverflow);

    let params = f.payout_params.to_engine();
    let (median_d, min_d, coalition) = (f.median_d, f.running_min_d, f.coalition_mode);
    let fixture_key = f.key();

    let mut sum_a_add: u128 = 0;
    let mut losers_add: u64 = 0;
    for acc in ctx.remaining_accounts.iter() {
        with_position(acc, fixture_key, |pos| {
            let is_winner = if coalition { pos.distance_d == min_d } else { pos.distance_d < median_d };
            pos.is_winner = is_winner;
            if is_winner {
                let r = if median_d == 0 {
                    0u128
                } else {
                    (pos.distance_d as u128 * engine::SCALE as u128) / median_d as u128
                };
                let a = engine::accuracy_weight(r, params.gamma);
                pos.accuracy_a = a;
                sum_a_add = sum_a_add.checked_add(a).ok_or(PerpError::Overflow)?;
            } else {
                losers_add = losers_add.checked_add(pos.stake_amount).ok_or(PerpError::Overflow)?;
            }
            Ok(())
        })?;
    }
    f.sum_a = f.sum_a.checked_add(sum_a_add).ok_or(PerpError::Overflow)?;
    f.losers_stake_sum = f.losers_stake_sum.checked_add(losers_add).ok_or(PerpError::Overflow)?;
    f.winners_processed_count += batch;

    if f.winners_processed_count == f.staker_count {
        // Take-adjusted dividend pool. Exact platform_cut is set at payout time
        // (losers_stake_sum − winners_gain_sum) so integer dust is absorbed.
        f.dividend_pool = ((f.losers_stake_sum as u128
            * (10_000 - f.payout_params.take_rate_bps as u128))
            / 10_000) as u64;
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Phase 5 — compute_payouts_batch (water-fill, one round per call)
// --------------------------------------------------------------------------
//
// Each call performs ONE water-fill round across all winners passed in
// remaining_accounts: compute `alpha` from the live accumulators, then clamp any
// winner whose naive share exceeds their cap and cascade the excess. When a full
// pass produces no new caps, finalize every uncapped winner at the current
// `alpha`, route dust/residual to `platform_cut`, and mark the fixture `Settled`.
// Bounded at 10 rounds (spec §5.4 step 8) — a runaway routes the remainder to
// the platform rather than stranding the fixture.

pub fn compute_payouts_batch(ctx: Context<PipelineBatch>) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    require!(
        f.winners_processed_count == f.staker_count
            && f.status == FixtureStatus::MedianVerified,
        PerpError::PhaseIncomplete
    );

    let scale = engine::SCALE as u128;
    let cap_multiple = f.payout_params.cap_multiple as u128;
    let fixture_key = f.key();

    // Live uncapped totals.
    let sum_a_uncapped = f.sum_a.checked_sub(f.capped_a_sum).ok_or(PerpError::Overflow)?;
    let pool_uncapped = (f.dividend_pool as u128)
        .checked_sub(f.capped_gain_sum as u128)
        .ok_or(PerpError::Overflow)?;

    // No uncapped winners left (all capped): route the residual to the platform
    // and settle — every winner already has a payout.
    if sum_a_uncapped == 0 {
        f.undistributed = pool_uncapped as u64;
        f.platform_cut = f.losers_stake_sum.saturating_sub(f.capped_gain_sum);
        f.status = FixtureStatus::Settled;
        return Ok(());
    }

    let alpha = (pool_uncapped * scale) / sum_a_uncapped;
    // Safety bound (spec §5.4 step 8): after 10 rounds, stop capping and pay the
    // rest at the current alpha rather than stranding the fixture.
    let force_finalize = f.waterfill_round >= 10;

    // One pass: clamp any newly-capped winner (skipped when forcing finalize).
    if !force_finalize {
        let mut new_capped_gain: u64 = 0;
        let mut new_capped_a: u128 = 0;
        let mut any_new_cap = false;
        for acc in ctx.remaining_accounts.iter() {
            with_position(acc, fixture_key, |pos| {
                if !pos.is_winner || pos.capped {
                    return Ok(());
                }
                let naive = (alpha * pos.accuracy_a) / scale;
                let cap = pos.stake_amount as u128 * cap_multiple;
                if naive > cap {
                    pos.capped = true;
                    pos.payout_amount = pos.stake_amount + cap as u64;
                    new_capped_gain =
                        new_capped_gain.checked_add(cap as u64).ok_or(PerpError::Overflow)?;
                    new_capped_a =
                        new_capped_a.checked_add(pos.accuracy_a).ok_or(PerpError::Overflow)?;
                    any_new_cap = true;
                }
                Ok(())
            })?;
        }
        if any_new_cap {
            // Fold new caps into the accumulators and let the keeper call again.
            f.capped_gain_sum =
                f.capped_gain_sum.checked_add(new_capped_gain).ok_or(PerpError::Overflow)?;
            f.capped_a_sum = f.capped_a_sum.checked_add(new_capped_a).ok_or(PerpError::Overflow)?;
            f.waterfill_round += 1;
            return Ok(());
        }
    }

    // No new caps — finalize every remaining uncapped winner at `alpha`, summing
    // their actual (floored) gains so platform_cut is exact.
    let mut uncapped_gain_sum: u64 = 0;
    for acc in ctx.remaining_accounts.iter() {
        uncapped_gain_sum = uncapped_gain_sum
            .checked_add(with_position(acc, fixture_key, |pos| {
                if pos.is_winner && !pos.capped {
                    let gain = ((alpha * pos.accuracy_a) / scale) as u64;
                    pos.payout_amount = pos.stake_amount + gain;
                    Ok(gain)
                } else {
                    Ok(0)
                }
            })?)
            .ok_or(PerpError::Overflow)?;
    }

    // Exact conservation: platform_cut = losers' stakes − every gain actually paid
    // (capped + uncapped). Floored dust falls into platform_cut automatically.
    let winners_gain_sum =
        f.capped_gain_sum.checked_add(uncapped_gain_sum).ok_or(PerpError::Overflow)?;
    f.undistributed = pool_uncapped.saturating_sub(uncapped_gain_sum as u128) as u64;
    f.platform_cut = f.losers_stake_sum.saturating_sub(winners_gain_sum);
    f.status = FixtureStatus::Settled;
    Ok(())
}
