use anchor_lang::prelude::*;

#[error_code]
pub enum PerpError {
    #[msg("Fixture is not in the required status for this instruction")]
    WrongStatus,
    #[msg("Staking window is closed (clock >= lock_time)")]
    StakingClosed,
    #[msg("Cannot lock before lock_time")]
    TooEarlyToLock,
    #[msg("Stake amount must be greater than zero")]
    ZeroStake,
    #[msg("Guessed goals exceed the allowed maximum")]
    GuessOutOfRange,
    #[msg("TxLine reports the match is not finished; cannot validate score")]
    MatchNotFinished,
    #[msg("TxLine score proof did not validate the claimed final score")]
    ScoreProofRejected,
    #[msg("Score proof payload is malformed (wrong stat keys, leaf count, or fixture)")]
    BadScoreProof,
    #[msg("A remaining account did not match the expected StakePosition PDA")]
    AccountMismatch,
    #[msg("A StakePosition belongs to a different fixture")]
    WrongFixture,
    #[msg("Batch would exceed the fixture's staker count")]
    BatchOverflow,
    #[msg("Median candidate failed the order-statistic check")]
    BadMedian,
    #[msg("Conservation invariant violated: Σ payout + platform_cut != total_pool")]
    ConservationFailed,
    #[msg("Provided settlement entry does not match the recomputed distance")]
    DistanceMismatch,
    #[msg("Position already claimed")]
    AlreadyClaimed,
    #[msg("Nothing to claim for this position")]
    NothingToClaim,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Number of remaining accounts must match the settlement entries")]
    EntryCountMismatch,
    #[msg("Pipeline phase is not complete yet")]
    PhaseIncomplete,
}
