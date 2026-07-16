//! Market A proximity distance `D` — fixed-point port of `distanceA`
//! (reference engine, `proximity-markets-simulator-trepa.html:521`).
//!
//! Split the score into two independent signals (goal difference and total
//! goals) so a wrong *winner* is categorically worse than a right winner with a
//! wrong margin — the fairness guarantee proven in the proximity-markets spec
//! §1.4. The caps (`CAP_GD`, `CAP_TG`) are what make that guarantee hold.

use crate::SCALE;

/// Per-fixture distance parameters. Weights are fixed-point (× [`SCALE`]); caps
/// are integer goal counts. Set at fixture creation, tunable per competition
/// (Solana build spec §2 / proximity-markets spec §1.7) — not hardcoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DistParams {
    /// Flat penalty for calling the wrong outcome (Home/Draw/Away). Fixed-point.
    pub p: u64,
    /// Weight on goal-difference error. Fixed-point.
    pub w_gd: u64,
    /// Weight on total-goals error. Fixed-point.
    pub w_tg: u64,
    /// Weight on each clean-sheet-call mismatch. Fixed-point.
    pub w_cs: u64,
    /// Cap on goal-difference error (integer goals).
    pub cap_gd: u8,
    /// Cap on total-goals error (integer goals).
    pub cap_tg: u8,
}

impl DistParams {
    /// Spec defaults: `P=4.0, W_GD=1.0, W_TG=0.5, W_CS=0.25, CAP_GD=3, CAP_TG=4`.
    pub const fn defaults() -> Self {
        Self {
            p: 4 * SCALE,       // 4.0
            w_gd: SCALE,        // 1.0
            w_tg: SCALE / 2,    // 0.5
            w_cs: SCALE / 4,    // 0.25
            cap_gd: 3,
            cap_tg: 4,
        }
    }
}

impl Default for DistParams {
    fn default() -> Self {
        Self::defaults()
    }
}

/// Sign of a goal difference: `1` Home, `-1` Away, `0` Draw. The outcome bucket.
#[inline]
pub fn outcome_sign(gd: i32) -> i32 {
    match gd.cmp(&0) {
        core::cmp::Ordering::Greater => 1,
        core::cmp::Ordering::Less => -1,
        core::cmp::Ordering::Equal => 0,
    }
}

/// Market A distance `D` for a guess `(gh, ga)` against actual `(ah, aa)`.
///
/// Returned in fixed-point (× [`SCALE`]), so `1.75` comes back as `1_750_000`.
///
/// ```text
/// D = (1-correct)·P + W_GD·min(|Δgd|,CAP_GD) + W_TG·min(|Δtg|,CAP_TG)
///   + W_CS·(|Δcs_home| + |Δcs_away|)
/// ```
pub fn distance_a(gh: u8, ga: u8, ah: u8, aa: u8, params: &DistParams) -> u64 {
    let (gh, ga, ah, aa) = (gh as i32, ga as i32, ah as i32, aa as i32);

    let gd_guess = gh - ga;
    let gd_actual = ah - aa;
    let tg_guess = gh + ga;
    let tg_actual = ah + aa;

    let correct = (outcome_sign(gd_guess) == outcome_sign(gd_actual)) as u64;

    let d_gd = (gd_guess - gd_actual).unsigned_abs().min(params.cap_gd as u32) as u64;
    let d_tg = (tg_guess - tg_actual).unsigned_abs().min(params.cap_tg as u32) as u64;

    // Clean-sheet calls: an away score of 0 ⇒ home kept a clean sheet, etc.
    let cs_home_guess = (ga == 0) as u64;
    let cs_home_actual = (aa == 0) as u64;
    let cs_away_guess = (gh == 0) as u64;
    let cs_away_actual = (ah == 0) as u64;
    let cs_term = cs_home_guess.abs_diff(cs_home_actual) + cs_away_guess.abs_diff(cs_away_actual);

    // Weights are fixed-point; the multipliers (d_gd, d_tg, cs_term) and
    // (1-correct) are small integers, so each product stays in fixed-point.
    (1 - correct) * params.p
        + params.w_gd * d_gd
        + params.w_tg * d_tg
        + params.w_cs * cs_term
}
