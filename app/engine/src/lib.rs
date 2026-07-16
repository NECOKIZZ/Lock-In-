//! Player Perps — Market A settlement engine (chain-agnostic, fixed-point).
//!
//! Everything here is deterministic integer math — **no floats** (Solana build
//! spec §4). Ratios are stored as integers scaled by [`SCALE`]. Stakes and
//! payouts are in USDC base units (6 decimals), which conveniently share the
//! same scale.
//!
//! Two entry points:
//! - [`distance_a`] — the Market A proximity distance `D` for one guess.
//! - [`settle`] — the full Trepa payout (void → coalition → median gate →
//!   accuracy weight → cap + water-fill → conservation check).
//!
//! Ported to match the tested reference engine `settleTrepa` in
//! `proximity-markets-simulator-trepa.html` (lines 521–611); its numeric output
//! is the acceptance test (see `tests/worked_example.rs`).

pub mod distance;
pub mod settle;

/// Fixed-point scale — 6 decimals, matching USDC's own decimal count
/// (Solana build spec §4). `1.0` is represented as `SCALE`.
pub const SCALE: u64 = 1_000_000;

pub use distance::{distance_a, outcome_sign, DistParams};
pub use settle::{
    accuracy_weight, settle, PayoutParams, Position, PositionOutcome, SettleResult, VoidReason,
};
