//! Lifecycle instructions: initialize → stake → lock → validate → claim.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::PerpError;
use crate::state::{DistParams, Fixture, FixtureStatus, PayoutParams, StakePosition};

/// A staged football score can't plausibly exceed this — cheap sanity clamp on guesses.
const MAX_GOALS: u8 = 30;

// --------------------------------------------------------------------------
// initialize_fixture
// --------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(txline_fixture_id: u64)]
pub struct InitializeFixture<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Fixture::SIZE,
        seeds = [b"fixture".as_ref(), txline_fixture_id.to_le_bytes().as_ref()],
        bump
    )]
    pub fixture: Account<'info, Fixture>,

    pub usdc_mint: Account<'info, Mint>,

    /// Escrow token account owned by the fixture PDA.
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = fixture,
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_fixture(
    ctx: Context<InitializeFixture>,
    txline_fixture_id: u64,
    lock_time: i64,
    dist_params: DistParams,
    payout_params: PayoutParams,
) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    f.txline_fixture_id = txline_fixture_id;
    f.lock_time = lock_time;
    f.status = FixtureStatus::Open;
    f.dist_params = dist_params;
    f.payout_params = payout_params;
    f.actual_home = 0;
    f.actual_away = 0;
    f.total_pool = 0;
    f.staker_count = 0;
    f.usdc_mint = ctx.accounts.usdc_mint.key();
    f.escrow = ctx.accounts.escrow.key();
    f.authority = ctx.accounts.authority.key();
    f.bump = ctx.bumps.fixture;
    // All pipeline accumulators default to 0 / false.
    Ok(())
}

// --------------------------------------------------------------------------
// stake
// --------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"fixture", &fixture.txline_fixture_id.to_le_bytes()],
        bump = fixture.bump,
    )]
    pub fixture: Account<'info, Fixture>,

    /// One position per staker per fixture — PDA derivation enforces uniqueness.
    #[account(
        init,
        payer = staker,
        space = StakePosition::SIZE,
        seeds = [b"stake".as_ref(), fixture.txline_fixture_id.to_le_bytes().as_ref(), staker.key().as_ref()],
        bump
    )]
    pub position: Account<'info, StakePosition>,

    #[account(
        mut,
        constraint = staker_usdc.mint == fixture.usdc_mint,
        constraint = staker_usdc.owner == staker.key(),
    )]
    pub staker_usdc: Account<'info, TokenAccount>,

    #[account(mut, address = fixture.escrow)]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn stake(ctx: Context<Stake>, guess_home: u8, guess_away: u8, amount: u64) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    require!(f.status == FixtureStatus::Open, PerpError::WrongStatus);
    require!(amount > 0, PerpError::ZeroStake);
    require!(guess_home <= MAX_GOALS && guess_away <= MAX_GOALS, PerpError::GuessOutOfRange);

    let now = Clock::get()?.unix_timestamp;
    require!(now < f.lock_time, PerpError::StakingClosed);

    // Move the stake into escrow before recording it.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.staker_usdc.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        ),
        amount,
    )?;

    let pos = &mut ctx.accounts.position;
    pos.fixture = f.key();
    pos.staker = ctx.accounts.staker.key();
    pos.guess_home = guess_home;
    pos.guess_away = guess_away;
    pos.stake_amount = amount;
    pos.distance_d = 0;
    pos.is_winner = false;
    pos.accuracy_a = 0;
    pos.capped = false;
    pos.payout_amount = 0;
    pos.claimed = false;
    pos.bump = ctx.bumps.position;

    f.total_pool = f.total_pool.checked_add(amount).ok_or(PerpError::Overflow)?;
    f.staker_count = f.staker_count.checked_add(1).ok_or(PerpError::Overflow)?;
    Ok(())
}

// --------------------------------------------------------------------------
// lock_fixture — permissionless
// --------------------------------------------------------------------------

#[derive(Accounts)]
pub struct LockFixture<'info> {
    #[account(
        mut,
        seeds = [b"fixture", &fixture.txline_fixture_id.to_le_bytes()],
        bump = fixture.bump,
    )]
    pub fixture: Account<'info, Fixture>,
}

pub fn lock_fixture(ctx: Context<LockFixture>) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    require!(f.status == FixtureStatus::Open, PerpError::WrongStatus);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= f.lock_time, PerpError::TooEarlyToLock);
    f.status = FixtureStatus::Locked;
    Ok(())
}

// --------------------------------------------------------------------------
// validate_score
// --------------------------------------------------------------------------

// TxLine soccer stat keys (prefix 0 = whole-match Total): Participant 1/2 total
// goals. At a `game_finalised` record this is the 120' score (extra time
// included; penalty-shootout goals live in the separate 6000-series keys, so a
// shootout never moves these). See tx-on-chain `documentation/scores/soccer-feed`.
const STAT_KEY_P1_GOALS: u32 = 1;
const STAT_KEY_P2_GOALS: u32 = 2;

// Milliseconds per UTC day — TxLine timestamps are epoch-ms; the daily-scores
// root PDA is seeded by `epoch_day = ts / DAY_MS` as a u16 little-endian.
const DAY_MS: i64 = 86_400_000;

// TxLine tags every `game_finalised` score stat with period 100 (verified against a
// devnet finalised record). Requiring it stops settlement on an in-play snapshot —
// covers regulation/ET/penalty/abandoned finishes with one marker.
const FINALISED_PERIOD: i32 = 100;

// ---- Real path: prove the final score against TxLine's on-chain Merkle root ----
#[cfg(not(feature = "dev-validate"))]
#[derive(Accounts)]
#[instruction(payload: crate::txoracle::types::StatValidationInputV3)]
pub struct ValidateScore<'info> {
    #[account(
        mut,
        seeds = [b"fixture", &fixture.txline_fixture_id.to_le_bytes()],
        bump = fixture.bump,
    )]
    pub fixture: Account<'info, Fixture>,

    /// CHECK: TxLine's `daily_scores_roots` PDA, pinned by seeds under the txoracle
    /// program and derived from the proof's own timestamp — so the keeper cannot
    /// point validation at a stale or foreign root. Read-only; verified inside the CPI.
    #[account(
        seeds = [b"daily_scores_roots", &(((payload.ts / DAY_MS) as u16).to_le_bytes())],
        bump,
        seeds::program = txoracle_program.key(),
    )]
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,

    /// CHECK: pinned by address to the network's txoracle program id; used only as
    /// the CPI target.
    #[account(address = crate::TXORACLE_PROGRAM_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
}

#[cfg(not(feature = "dev-validate"))]
pub fn validate_score(
    ctx: Context<ValidateScore>,
    payload: crate::txoracle::types::StatValidationInputV3,
    home: u8,
    away: u8,
) -> Result<()> {
    use crate::txoracle::types::{Comparison, NDimensionalStrategy, StatPredicate, TraderPredicate};

    require!(
        ctx.accounts.fixture.status == FixtureStatus::Locked,
        PerpError::WrongStatus
    );

    // The proof must be for THIS fixture and carry exactly the two total-goals
    // leaves, in the order the strategy indexes assume (index 0 = home, 1 = away).
    require!(
        payload.fixture_summary.fixture_id as u64 == ctx.accounts.fixture.txline_fixture_id,
        PerpError::WrongFixture
    );
    require!(payload.leaves.len() == 2, PerpError::BadScoreProof);
    require!(
        payload.leaves[0].stat.key == STAT_KEY_P1_GOALS
            && payload.leaves[1].stat.key == STAT_KEY_P2_GOALS,
        PerpError::BadScoreProof
    );
    // Both leaves must come from the finalised record, or we could settle a live score.
    require!(
        payload.leaves[0].stat.period == FINALISED_PERIOD
            && payload.leaves[1].stat.period == FINALISED_PERIOD,
        PerpError::MatchNotFinished
    );

    // Build the equality predicate in-program so the keeper can't weaken it:
    // prove leaf0 (P1 goals) == home AND leaf1 (P2 goals) == away.
    let strategy = NDimensionalStrategy {
        geometric_targets: Vec::new(),
        distance_predicate: None,
        discrete_predicates: vec![
            StatPredicate::Single {
                index: 0,
                predicate: TraderPredicate {
                    threshold: home as i32,
                    comparison: Comparison::EqualTo,
                },
            },
            StatPredicate::Single {
                index: 1,
                predicate: TraderPredicate {
                    threshold: away as i32,
                    comparison: Comparison::EqualTo,
                },
            },
        ],
    };

    // CPI into txoracle: verifies every leaf's Merkle proof against the pinned
    // daily-scores root, then evaluates the strategy. Returns a bool.
    let cpi_accounts = crate::txoracle::cpi::accounts::ValidateStatV3 {
        daily_scores_merkle_roots: ctx.accounts.daily_scores_merkle_roots.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.txoracle_program.to_account_info(),
        cpi_accounts,
    );
    let proven = crate::txoracle::cpi::validate_stat_v3(cpi_ctx, payload, strategy)?.get();
    require!(proven, PerpError::ScoreProofRejected);

    let f = &mut ctx.accounts.fixture;
    f.actual_home = home;
    f.actual_away = away;
    f.status = FixtureStatus::ScoreValidated;
    Ok(())
}

// ---- Dev path: trust an injected score (localnet, no txoracle deployed) ----
#[cfg(feature = "dev-validate")]
#[derive(Accounts)]
pub struct ValidateScore<'info> {
    #[account(
        mut,
        seeds = [b"fixture", &fixture.txline_fixture_id.to_le_bytes()],
        bump = fixture.bump,
    )]
    pub fixture: Account<'info, Fixture>,
}

#[cfg(feature = "dev-validate")]
pub fn validate_score(
    ctx: Context<ValidateScore>,
    _payload: crate::txoracle::types::StatValidationInputV3,
    home: u8,
    away: u8,
) -> Result<()> {
    require!(
        ctx.accounts.fixture.status == FixtureStatus::Locked,
        PerpError::WrongStatus
    );
    let f = &mut ctx.accounts.fixture;
    f.actual_home = home;
    f.actual_away = away;
    f.status = FixtureStatus::ScoreValidated;
    Ok(())
}

// --------------------------------------------------------------------------
// claim_payout
// --------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(
        seeds = [b"fixture", &fixture.txline_fixture_id.to_le_bytes()],
        bump = fixture.bump,
    )]
    pub fixture: Account<'info, Fixture>,

    #[account(
        mut,
        seeds = [b"stake", &fixture.txline_fixture_id.to_le_bytes(), staker.key().as_ref()],
        bump = position.bump,
        constraint = position.staker == staker.key() @ PerpError::AccountMismatch,
        constraint = position.fixture == fixture.key() @ PerpError::WrongFixture,
    )]
    pub position: Account<'info, StakePosition>,

    #[account(mut, address = fixture.escrow)]
    pub escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = staker_usdc.mint == fixture.usdc_mint,
        constraint = staker_usdc.owner == staker.key(),
    )]
    pub staker_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
    let f = &ctx.accounts.fixture;
    let pos = &mut ctx.accounts.position;
    require!(!pos.claimed, PerpError::AlreadyClaimed);

    // Settled → pay the computed payout; Void → refund the original stake.
    let amount = match f.status {
        FixtureStatus::Settled => pos.payout_amount,
        FixtureStatus::Void => pos.stake_amount,
        _ => return err!(PerpError::WrongStatus),
    };
    require!(amount > 0, PerpError::NothingToClaim);

    // The fixture PDA signs the escrow → staker transfer.
    let id_bytes = f.txline_fixture_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"fixture", &id_bytes, &[f.bump]];
    let signer: &[&[&[u8]]] = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.staker_usdc.to_account_info(),
                authority: f.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;

    pos.claimed = true;
    Ok(())
}
