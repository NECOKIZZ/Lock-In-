# Player Perps — Match View UI Spec

Companion to `player-perps-ui-mockup.html` (open that file to see and interact with everything described here — the "Simulate goal" buttons at the bottom drive the live states). This document is what to build from; the HTML is what to look at.

---

## 1. Design tokens

**Color** — green and black, chosen deliberately as two greens playing different roles (not one green reused everywhere), plus one desaturated warm red kept intentionally muted so it never competes with the brand green:

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#070B09` | App background — near-black with a cool green undertone, not pure black |
| `--panel` | `#0D1410` | Card surfaces |
| `--panel-2` | `#121B15` | Recessed surfaces (digit wells, input backgrounds) |
| `--line` | `#1D2B22` | Borders, dividers |
| `--green-bright` | `#6EE896` | Signal green — live states, positive PnL, floodlight accent |
| `--green` | `#3E9E64` | Structural green — primary buttons, brand |
| `--green-dark` | `#1B3A26` | 3D button shadow depth |
| `--loss` | `#C97361` | Muted brick — negative PnL only, never decorative |
| `--text` | `#EAF2EC` | Primary text |
| `--dim` / `--dim-2` | `#7E9186` / `#4C5A51` | Secondary / tertiary text, labels |

**Type** — three roles, not one face doing everything:
- **Display (`Bebas Neue`)** — the live scoreboard digits and the glide-picker numbers only. Tall, condensed, stadium-signage character — this is the one place the design gets to look like a scoreboard, not an app.
- **Body (`Inter`)** — labels, buttons, copy.
- **Mono (`IBM Plex Mono`)** — every number that isn't a scoreboard digit: PnL figures, stakes, ranks, timestamps, D-values. Tabular alignment matters here — money and rank numbers should never visually jitter as digits change width.

**Radius/spacing** — 12–16px radii throughout, one consistent scale (10/14/16/22px), no sharp corners and no fully-round pill shapes except the live indicator and status badges, which are the only "chip" elements.

---

## 2. Components

### 2.1 Score Glide Picker (the arrows-and-numbers piece)
Two independently steppable digits (home / away), each with an up arrow above and down arrow below, not left-right — vertical glide reads more naturally as "counting up/down a score" than horizontal, and keeps both teams' controls symmetric on either side of the center dash. Each press:
- Increments/decrements 0–9 (clamp, no wraparound — a football score guess has no reason to go negative or loop).
- Triggers a **roll animation**: the digit slides up and fades out, the new value slides in from below and fades in, ~160ms, `cubic-bezier(.2,.9,.3,1)`. This is a small, cheap animation but it's the one that makes the picker feel physical rather than a plain `<input type=number>` with a nicer skin.
- Disabled entirely once the guess is locked (see 2.5) — the picker should visibly gray out, not just silently stop responding.

### 2.2 3D button system
One mechanism, three variants. The "3D" is achieved with a hard, unblurred offset shadow in a darker shade of the button's own color — not a gradient or glossy highlight, which would read as dated skeuomorphism rather than the flat, minimal instruction given. On press, the button translates down by exactly the shadow's offset and the shadow collapses to zero — the button visually "meets the surface." This reads as tactile without any decoration beyond color and a shadow.

| Variant | Fill | Shadow | Use |
|---|---|---|---|
| Primary | `--green` | `--green-dark` | Lock in stake, Cash out |
| Ghost | `--panel-2` | `--line` | Hold position, secondary actions |
| Danger | `--loss` | `--loss-dark` | Destructive actions (not used in this view, reserved for e.g. "forfeit position") |

Press offset: 6px down, 6px shadow depth, 80ms transition. Keep this identical across all three variants — the only thing that changes is color, never the physics.

### 2.3 Live fixture strip
Minimal: two crests, the live score in the display face, the match clock in mono beneath it in signal green, and a pulsing live-dot pill top-right. The pulse (`1.6s` ease-in-out opacity + soft glow) is the only ambient (non-triggered) animation in the whole view — everything else fires on an event. Keep it that way; more ambient motion starts to feel restless rather than alive.

### 2.4 Live PnL graph — the signature moment
This is the one place to spend the design's "boldness budget." X-axis is match time (kickoff to full time), Y-axis is projected payout if the match ended at that instant. A dashed breakeven line marks the stake amount — area above it fills in signal green, below it the line and fill switch to the muted brick, so the color itself tells you whether you're up or down without reading a number.

**The goal-event pulse** is the signature: when a goal fires, (1) the live score digits roll to the new value, (2) the graph redraws with the new projected-payout point, and (3) the whole graph card flashes once — a soft radial gradient bloom from the center, green if the goal helped your position, brick if it hurt it, fading over ~700ms. All three happen together, in the same instant, because that's genuinely what happens in the product: one event (a goal) changes your score-guess distance, your rank in the field, and your projected payout, all at once. The orchestration is honest to the mechanism, not decoration on top of it.

A dashed vertical marker with a small mono-font label (`62' GOAL — MEX`) appears on the graph at the moment of the event and persists — the line chart becomes a readable history of the match's key moments, not just a live number.

### 2.5 PnL cards
Two cards side by side: **stake** (static — what you put in, what you guessed) and **live rank** (dynamic — where you currently sit in the field, your live `D`, and whether that's above or below the field's live median). A status badge beneath states the projected outcome in plain language ("Projected winner — cash out available" / "Projected loser — cash out limits your loss") rather than just showing a number and leaving the person to interpret it — this is a case where the copy is doing real work, per the "words are design material" principle: nobody should have to do math in their head to know if they're currently winning.

### 2.6 Cash-out CTA
Two buttons: "Hold position" (ghost — the passive, default choice) and "Cash out — $X" (primary — the number is live-updated in the button label itself, not just above it, so the commitment is visible at the moment of the tap). This maps directly to the Tier 1 checkpoint cash-out mechanism already spec'd — the button's number is that mechanism's live quote, not a separate estimate.

---

## 3. Data wiring — what's real math vs. what's a demo stand-in

The mockup computes everything client-side using the exact same distance formula and Trepa engine already validated for settlement (§2 and §3 of the Solana build spec) — this isn't a fake number, it's the real formula run against a live proxy score instead of the final one. That distinction matters for the builder:

- **The graph and cards show a live *estimate***, computed the same way the Tier 1 cash-out quote is computed (§4 of the extensions doc) — recompute every staker's `D` against the current live score, find the live median, run the same accuracy-weight/cap math, treating "if it ended right now" as the hypothetical actual score.
- **This is never the on-chain settlement.** The real payout only becomes final once TxLine reports full-time and the Solana program validates it (§5.4 step 4 of the build spec). The UI should make this distinction legible to the person — the graph's number is a live projection, and the cash-out button is the mechanism that lets someone act on that projection early, at the haircut already specified. Don't let the live number and the settled number look like the same kind of fact in the UI; consider a small "estimate, not final" label near the graph if user testing shows people are confused by a number that can still move.
- **The field of other stakers** (used to compute the live median) needs a real data source in production — either a lightweight read of all `StakePosition` accounts for the fixture (public on-chain data, per the build spec) or a cached version of the same maintained by your own backend for responsiveness, since re-fetching every account on every live update is not something to do naively against RPC at goal-event frequency.

---

## 4. Accessibility and quality floor

- **Reduced motion:** the digit-roll, button-press, and goal-pulse animations should all respect `prefers-reduced-motion` — fall back to instant state changes, no roll/flash, for anyone who's set that preference.
- **Contrast:** `--green-bright` on `--bg` and `--loss` on `--bg` both need a contrast check against real device screens before shipping — brick reds tend to lose legibility at low brightness; test on an actual phone outdoors, not just a design tool.
- **Focus states:** every button and stepper needs a visible keyboard focus ring — the 3D press effect is a mouse/touch interaction, it doesn't substitute for a focus indicator for keyboard or switch-control users.
- **Color isn't the only signal:** the win/lose state is carried by color (green/brick) *and* the status badge's text *and* the badge's dot — never color alone, for the colorblind-safe reason as much as the "this is money, be unambiguous" reason.

## 5. Responsive
Single-column, max-width ~460px, centered — this is a phone-first view (matches the mobile-primary reality of a football/live-sports product). The picker row and card row both need to survive down to ~360px viewports without the digit shells or arrow buttons shrinking below a comfortable tap target (44px minimum, already respected in the mockup's button sizing).
