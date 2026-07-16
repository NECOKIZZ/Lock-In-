//! Player Perps — Market A (full-time score proximity) on Solana.
//!
//! Stakers lock USDC + a scoreline guess before kickoff. At full time the score
//! is validated against TxLine's on-chain Merkle proof, every staker's distance
//! `D` is computed, and the Trepa median-gate + accuracy-weight payout
//! redistributes losers' stakes to winners. All the math lives in the
//! chain-agnostic `engine` crate (proven against the spec's worked example);
//! this program owns escrow, the state machine, and two settlement paths:
//!
//! - **Fast path** (`submit_settlement`): a keeper computes settlement off-chain
//!   and submits it; the program does a cheap on-chain verify (recompute every
//!   `D`, check the median order-statistic, check conservation). Spec §5.5 —
//!   ship this for the deadline.
//! - **Full path** (`compute_distances_batch` → `verify_median_candidate` →
//!   `finalize_median` → `settle_batch` → `compute_payouts_batch`): the same
//!   math, batched and fully on-chain so nothing is trusted. Spec §5.4.
//!
//! Both converge on `StakePosition.payout_amount`, drained by `claim_payout`.

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::{DistParams, PayoutParams};

// Generates `txoracle::{types, accounts, cpi, program}` from the vendored IDL
// (idls/txoracle.json) so `validate_score` can CPI into TxLine's on-chain
// score-proof verifier. Feature-independent — compiles under `dev-validate` too.
declare_program!(txoracle);

// TxLine `txoracle` program id, pinned per network so the CPI target can't be
// spoofed (the vendored IDL bakes the *mainnet* address, so we can't rely on
// `Program<Txoracle>` on devnet). Default build targets devnet; build with
// `--features mainnet` to swap in the mainnet program.
// Byte arrays (not the `pubkey!` macro, which resolves `solana_program` awkwardly
// under this toolchain). Base58 round-trip verified against the addresses above.
#[cfg(feature = "mainnet")]
pub const TXORACLE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    122, 112, 232, 144, 103, 243, 35, 151, 42, 124, 169, 206, 129, 0, 62, 27, 229, 188, 245, 104,
    216, 114, 134, 163, 50, 218, 59, 122, 129, 146, 13, 211,
]); // 9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA
#[cfg(not(feature = "mainnet"))]
pub const TXORACLE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    86, 117, 159, 44, 144, 95, 120, 96, 200, 99, 119, 20, 191, 36, 145, 48, 157, 192, 113, 129, 81,
    63, 122, 36, 191, 62, 218, 248, 127, 119, 80, 3,
]); // 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J

// Matches target/deploy/player_perps-keypair.json (devnet deploy 2026-07-14, clean rerun).
declare_id!("6krdS27r9oHpiTwHemWXwcKSns7Dj3616pFwKNDgmE26");

#[program]
pub mod player_perps {
    use super::*;

    // ---- lifecycle ----

    pub fn initialize_fixture(
        ctx: Context<InitializeFixture>,
        txline_fixture_id: u64,
        lock_time: i64,
        dist_params: DistParams,
        payout_params: PayoutParams,
    ) -> Result<()> {
        instructions::initialize_fixture(ctx, txline_fixture_id, lock_time, dist_params, payout_params)
    }

    pub fn stake(ctx: Context<Stake>, guess_home: u8, guess_away: u8, amount: u64) -> Result<()> {
        instructions::stake(ctx, guess_home, guess_away, amount)
    }

    pub fn lock_fixture(ctx: Context<LockFixture>) -> Result<()> {
        instructions::lock_fixture(ctx)
    }

    /// Validate the final score against TxLine. The real build CPIs into TxLine's
    /// `txoracle::validate_stat_v3`, proving the claimed `(home, away)` against the
    /// on-chain daily-scores Merkle root before storing it. With the `dev-validate`
    /// feature it ignores `payload` and trusts the injected score for local testing.
    pub fn validate_score(
        ctx: Context<ValidateScore>,
        payload: txoracle::types::StatValidationInputV3,
        home: u8,
        away: u8,
    ) -> Result<()> {
        instructions::validate_score(ctx, payload, home, away)
    }

    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        instructions::claim_payout(ctx)
    }

    // ---- fast path (§5.5) ----

    pub fn submit_settlement<'info>(
        ctx: Context<'_, '_, '_, 'info, SubmitSettlement<'info>>,
        median_d: u64,
        platform_cut: u64,
        entries: Vec<SettlementEntry>,
    ) -> Result<()> {
        instructions::submit_settlement(ctx, median_d, platform_cut, entries)
    }

    // ---- full batched pipeline (§5.4) ----

    pub fn compute_distances_batch(ctx: Context<PipelineBatch>) -> Result<()> {
        instructions::compute_distances_batch(ctx)
    }

    pub fn verify_median_candidate(ctx: Context<PipelineBatch>, candidate: u64) -> Result<()> {
        instructions::verify_median_candidate(ctx, candidate)
    }

    pub fn finalize_median(ctx: Context<PipelineBatch>) -> Result<()> {
        instructions::finalize_median(ctx)
    }

    pub fn settle_batch(ctx: Context<PipelineBatch>) -> Result<()> {
        instructions::settle_batch(ctx)
    }

    pub fn compute_payouts_batch(ctx: Context<PipelineBatch>) -> Result<()> {
        instructions::compute_payouts_batch(ctx)
    }
}
