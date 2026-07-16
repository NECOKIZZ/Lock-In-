//! Acceptance tests. The Solana build spec §7 says: "If your implementation
//! produces anything else on this exact input, the bug is in your build, not in
//! this spec." So the worked example below is the contract.

use engine::{distance_a, settle, DistParams, PayoutParams, Position, VoidReason, SCALE};

/// USDC base units (6 decimals) for a whole-dollar amount.
fn usdc(dollars: u64) -> u64 {
    dollars * SCALE
}

/// Round base units to whole cents (half-up), for comparing against the spec's
/// dollar figures without being sensitive to sub-cent integer-flooring dust.
fn cents(base_units: u64) -> u64 {
    (base_units + 5_000) / 10_000
}

/// Build the five §7 stakers' positions from their guesses vs actual 2-1.
fn worked_example_positions() -> Vec<Position> {
    let dp = DistParams::defaults();
    // (guess_home, guess_away, stake $)
    let guesses = [
        (2u8, 1u8, 50u64), // A — exact
        (3, 1, 40),        // C
        (2, 0, 30),        // B
        (1, 1, 20),        // D
        (1, 2, 60),        // E
    ];
    guesses
        .iter()
        .map(|&(gh, ga, s)| Position { stake: usdc(s), d: distance_a(gh, ga, 2, 1, &dp) })
        .collect()
}

#[test]
fn distance_a_matches_spec_table() {
    let dp = DistParams::defaults();
    // From spec §7 / proximity-markets spec §1.5, actual 2-1.
    assert_eq!(distance_a(2, 1, 2, 1, &dp), 0); // A exact
    assert_eq!(distance_a(3, 1, 2, 1, &dp), 1_500_000); // C 1.50
    assert_eq!(distance_a(2, 0, 2, 1, &dp), 1_750_000); // B 1.75 (clean-sheet mismatch)
    assert_eq!(distance_a(1, 1, 2, 1, &dp), 5_500_000); // D 5.50 (wrong outcome)
    assert_eq!(distance_a(1, 2, 2, 1, &dp), 6_000_000); // E 6.00 (reversed)
}

#[test]
fn distance_a_fairness_examples() {
    let dp = DistParams::defaults();
    // proximity-markets spec §1.5: right winner, wildly wrong margin still beats
    // any wrong-winner guess for the same actual result.
    let d_right_wild = distance_a(6, 1, 1, 0, &dp); // 1-0 actual, guess 6-1 → 5.25
    let d_wrong_close = distance_a(0, 0, 1, 0, &dp); // called a draw on a 1-0 → 5.75
    assert_eq!(d_right_wild, 5_250_000);
    assert_eq!(d_wrong_close, 5_750_000);
    assert!(d_right_wild < d_wrong_close, "right-winner must beat wrong-winner");
}

#[test]
fn worked_example_settles_exactly_as_spec_7() {
    let positions = worked_example_positions();
    let res = settle(&positions, &PayoutParams::defaults());

    assert!(res.void.is_none());
    assert_eq!(res.k, 3);
    assert_eq!(res.median_d, 1_750_000, "median D = 1.75");
    assert!(!res.coalition_mode);
    assert_eq!(res.min_d, 0);
    assert_eq!(res.count_at_min, 1);

    // Winners are A (idx 0) and C (idx 1); B, D, E lose.
    let win: Vec<bool> = res.outcomes.iter().map(|o| o.is_winner).collect();
    assert_eq!(win, vec![true, true, false, false, false]);

    // Payouts to the cent — spec §7: A $135.91, C $42.09, rest $0.
    assert_eq!(cents(res.outcomes[0].payout), 13_591, "payout A = $135.91");
    assert_eq!(cents(res.outcomes[1].payout), 4_209, "payout C = $42.09");
    assert_eq!(res.outcomes[2].payout, 0);
    assert_eq!(res.outcomes[3].payout, 0);
    assert_eq!(res.outcomes[4].payout, 0);

    // Platform take $22.00 (to the cent) and exact conservation to $200.
    assert_eq!(cents(res.platform_cut), 2_200, "platform take = $22.00");
    assert_eq!(res.total_pool, usdc(200));
    assert!(res.conserves(), "Σ payout + platform_cut must equal total_pool exactly");

    let paid: u64 = res.outcomes.iter().map(|o| o.payout).sum();
    assert_eq!(paid + res.platform_cut, usdc(200));
}

#[test]
fn void_when_fewer_than_two() {
    let positions = vec![Position { stake: usdc(50), d: 0 }];
    let res = settle(&positions, &PayoutParams::defaults());
    assert_eq!(res.void, Some(VoidReason::FewerThanTwo));
    assert_eq!(res.outcomes[0].payout, usdc(50)); // refunded
    assert!(res.conserves());
}

#[test]
fn void_when_all_distances_equal() {
    let positions = vec![
        Position { stake: usdc(10), d: 3_000_000 },
        Position { stake: usdc(20), d: 3_000_000 },
        Position { stake: usdc(30), d: 3_000_000 },
    ];
    let res = settle(&positions, &PayoutParams::defaults());
    assert_eq!(res.void, Some(VoidReason::AllEqualD));
    // Everyone refunded exactly.
    assert_eq!(res.outcomes[0].payout, usdc(10));
    assert_eq!(res.outcomes[1].payout, usdc(20));
    assert_eq!(res.outcomes[2].payout, usdc(30));
    assert!(res.conserves());
}

#[test]
fn best_coalition_when_half_tie_at_minimum() {
    // 4 stakers, 2 tied at the minimum D=0 → coalition (2*2 >= 4).
    let positions = vec![
        Position { stake: usdc(10), d: 0 },
        Position { stake: usdc(10), d: 0 },
        Position { stake: usdc(50), d: 5_000_000 },
        Position { stake: usdc(50), d: 6_000_000 },
    ];
    let res = settle(&positions, &PayoutParams::defaults());
    assert!(res.void.is_none());
    assert!(res.coalition_mode, "half the field tied at min D wins as a coalition");
    assert_eq!(res.count_at_min, 2);
    let win: Vec<bool> = res.outcomes.iter().map(|o| o.is_winner).collect();
    assert_eq!(win, vec![true, true, false, false]);
    // Losers' $100, 20% take → $80 split between the two equal-D winners = $40 each.
    assert_eq!(cents(res.outcomes[0].payout), 5_000, "coalition winner = $50 ($10 + $40)");
    assert_eq!(cents(res.outcomes[1].payout), 5_000);
    assert_eq!(res.outcomes[2].payout, 0);
    assert!(res.conserves());
}

#[test]
fn water_fill_caps_and_routes_residual_to_platform() {
    // Force caps: cap_multiple = 1 (gain capped at 1× stake), one tiny winner,
    // a large loser pool it can't absorb. Residual must route to platform, and
    // conservation must still hold (spec §6 edge case).
    let params = PayoutParams { gamma: 6, take_rate_bps: 2000, cap_multiple: 1 };
    let positions = vec![
        Position { stake: usdc(1), d: 0 },          // sole winner, cap = $1
        Position { stake: usdc(100), d: 5_000_000 },// loser
        Position { stake: usdc(100), d: 6_000_000 },// loser (sets median above winner)
    ];
    let res = settle(&positions, &params);
    assert!(res.void.is_none());
    assert!(res.outcomes[0].is_winner);
    assert!(res.outcomes[0].capped, "winner should hit the 1× cap");
    assert_eq!(res.outcomes[0].payout, usdc(2)); // $1 stake + $1 capped gain
    assert!(res.undistributed > 0, "capped-out residual should be recorded");
    assert!(res.conserves(), "residual routes to platform_cut, nothing vanishes");
}
