# Codebase Analysis & Improvement Plan

*Analyzed 2026-07-20. Covers the self-learning loop, all 14 screeners, data layer, signals, and exit engine.*

The system's strongest assets are the regime gate, the outcome ledger + guardrailed weight learner, and the triggers execution layer. The biggest liabilities are statistical flaws in the learning loop, a handful of outright bugs in the signal path, and a liquidity blind spot. Fixes below are grouped and ranked; the "Critical bugs" section is worth doing this week.

---

## 1. Critical bugs (fix first — small effort, direct P&L impact)

**1.1 The R:R gate in `lib/signals.js` is tautological.**
`target = entry + targetRRMult × (entry − stop)` and `rr = (target − entry)/(entry − stop)`, so `rr ≡ targetRRMult (1.5)` by construction (lines 42–43). In bull regime `meetsRR` (1.5 ≥ 1.2) always passes — conveys nothing. In bear regime `minRRBear = 1.8 > 1.5` means **every trigger silently fails and is dropped** in `generate-triggers.js:119`. Fix: compute R:R against a *structural* target (prior base high, measured move), not a multiple of itself.

**1.2 Exit engine loses trailing-stop progress.** In `monitor.js` (`checkExitConditions`), updated `currentStop` values persist to `trades-data.json` only when alerts fired — line 435 returns before the persist block (437–441). On quiet days trailing progress is discarded.

**1.3 Regime gate fails open to BULL.** `lib/regime.js:50,57` — if `regime.json` is missing or stale, everything defaults to bull and all gates go loose. A broken risk gate should tighten, not loosen.

**1.4 Indian Research sidecar exports raw ROE as its "score".** `generate-indianresearch.js` (~line 1016): `score: Math.round(s.roe)` — confluence then percentile-ranks a raw ROE against real 0–100 composites. Also `F3_VOL_MULT = 1.5` while the comment claims 3×.

**1.5 Two registry features are permanently dead.** `lib/features.js:107–108` says `ret126_21`/`ret63` are "filled by feature-lab from bars" — no such code exists in `feature-lab.js`. They are always null → permanently INSUFFICIENT, silently changing block composition per ticker.

**1.6 `learn-weights.js` config inconsistency.** `bpFloor = 0.3` is below `CLAMP_LO = 0.5`, so the stated demotion floor is unreachable.

**1.7 Returns use `close`, not `adjClose`.** `validate-screeners.js:48` — any bonus/split inside a horizon produces a wildly wrong outcome label.

---

## 2. The self-learning loop: statistically unsound as-is

The guardrail architecture (tanh shrinkage, clamps, EMA smoothing, freeze switch, provenance) is well engineered — but it's wrapped around invalid inputs. **Weights have already moved on ~22 days of one market regime counted as n≈1000 of independent evidence** (confluence pushed to 0.77, apex 0.66).

**2.1 Pseudo-replication inflates sample size (most serious flaw).**
The same ticker is re-logged every day it stays on a screener; adjacent-day rows share ~95% of their 20-day return window, and all ~47 picks per day share the same market path. `confluence|*` shows n=1025, conf=0.976 — the effective independent sample is closer to 1–2 regime observations.
Fix: (a) dedupe outcomes to first emission per ticker-episode (or one entry per ticker per 20 trading days); (b) in `feature-lab.js`, replace pooled Spearman IC with per-date cross-sectional IC, Fama-MacBeth style, with the t-stat computed over the daily IC series (n = number of dates); (c) base `conf = n/(n+k)` in `learn-weights.js` on effective n (distinct entry dates).

**2.2 Survivorship censoring.** `validate-screeners.js:123` — tickers whose Yahoo fetch fails (delisted/suspended — the worst outcomes) are silently skipped forever, biasing every measured alpha upward. Track fetch failures; after N failures past maturity impute a conservative loss or flag as censored.

**2.3 Selection feedback loop.** `feature-history.jsonl` only ever contains stocks *already selected* by the score the features compose (`generate-bestpicks.js:526`, master ≥ 50, top 120). Feature ICs are estimated on a range-restricted sample — a genuinely predictive feature gets its measured IC attenuated and wrongly SHADOW-demoted. Fix: also log feature vectors + outcomes for a random/stratified holdout of ~30 *non-picked* tickers per day (`picked: false`) and compute IC over the full cross-section. Similarly keep logging outcomes for demoted screeners so they can rehabilitate.

**2.4 No train/test separation, no decay, no policy validation.** `learn-weights.js` uses all-time medians; nothing measures whether weighted scoring beats neutral scoring. Fix: trailing window or exponential decay by entry date; record daily what neutral weights would have picked and compare realized alpha of weighted vs. neutral. If the learner can't beat its neutral baseline out-of-sample, freeze it. The `recentIC` "drift detector" uses the last 150 rows ≈ 1–2 days of data — widen to a date-based window.

**2.5 P(beat Nifty in 20d) is currently false precision.** With 0 matured bestpicks outcomes, every displayed winProb comes from the hardcoded prior in `lib/master-score.js:87–114`. When data matures: use isotonic regression (monotone) instead of raw decile bins, date-clustered CIs, a minimum number of distinct entry dates before leaving the prior, and label prior-based outputs as "uncalibrated" in the UI. Consider a beta-adjusted benchmark — high-beta small caps "beat Nifty" mechanically in up-tapes.

**2.6 Gating needs hysteresis + multiplicity control.** 23 features tested one-sided at t ≥ 1.5 with no correction guarantees false LIVE promotions; boundary features saw-tooth between ~0.5 and ~1.3. Promote at IC ≥ 0.05 & t ≥ 2 (or Benjamini-Hochberg), demote only below IC < 0.01, with a multi-run cooldown.

---

## 3. Screener portfolio: consolidate and fill gaps

**3.1 Retire/merge redundancy** (also concentrates outcome samples so the learner converges months faster):

| Action | Rationale |
|---|---|
| Retire `generate-breakout.js` (v1) | Strict subset of breakout2, with a worse pivot bug (breakout bar can be its own pivot), watchlist-only universe, no ATR/RS. Add a "watchlist-only" toggle to breakout2 instead. |
| Delete `generate-potential.js` | Ranks Tickertape's own opaque tags; strict subset of creamy's gate. |
| Unify apex + multibagger + rocket-FUEL | ~80% copy-pasted fundamental scoring tables. One fundamental engine with cap-segment presets (top-300 / full universe / ₹200–5,000 Cr). |
| Fold `confluence` and `debate` into `bestpicks` | Three meta-aggregators recombine the identical six sidecars. Bestpicks (z-scores, regime tilt, calibration, learned weights) strictly dominates. Debate's "5 agents" are deterministic re-reads of the same sidecars; discretizing scores into 3 votes destroys information. |
| Extract shared `lib/technical.js` | Stage2/VCP analyzer, RS computation, and the Tickertape client are copy-pasted across 4+ files and re-implemented in prediction — silent drift risk. |

**3.2 Confluence double-counts correlated signals.** Apex P5 is hard-gated on breakout2; rocket consumes breakout2's VCP; apex/MBF share factor code. The 1.0→4.0 conviction multiplier for 1→6 screeners mostly rewards correlation and large caps (which appear in more universes by construction — apex covers top 300, breakout2 top 800, so midcaps systematically get fewer hits). If confluence is kept, weight overlap by measured signal correlation.

**3.3 Fix VCP/pivot in breakout2 (the execution layer inherits it).** Current pivot = prior 10-day high — not a base pivot; shallow flags trigger constantly, and `generate-triggers.js` trades them. Implement a proper base structure: pivot = base high over ≥5–6 weeks; VCP = count of successive contractions with roughly halving depth (currently a loose either/or of two crude checks). This is where real money enters — highest structural-impact fix.

**3.4 Methodological gaps across all screeners:**
- **No liquidity filter anywhere.** No screener checks median ₹ traded value / ADV. Rocket scans ₹200–5,000 Cr names where impact costs can exceed the modeled edge. Add an ADV floor + ADV-based position-size cap. Cheapest way to stop paper edge from being fake.
- **CANSLIM "C" is missing.** No quarterly earnings surprise/acceleration anywhere except creamy's one factor; no estimate revisions (creamy fetches Yahoo forward estimates but only displays them). PEAD/earnings-revision momentum is one of the best-documented effects.
- **No earnings blackout in triggers** despite `fetch-earnings-calendar.js` + `lib/earnings.js earningsWithin()` already existing. Wire it in — don't enter 5 days before results.
- **No sector normalization** beyond the `/bank|finance|nbfc/` regex hack. Absolute ROE/PE/EV-EBITDA thresholds structurally favor asset-light sectors. Use sector-relative z-scores.
- **Incompatible RS ratings.** Breakout2/rocket compute RS percentiles within their own scan universes — "RS 90" means different things per page, and confluence merges them anyway. Compute one exchange-wide RS in breakout2 and share via sidecar.
- **No historical backtest.** Every threshold (score ≥40/55/65, VCP windows, RS cutoffs) is hand-set and unvalidated; the forward ledger needs months to mature. A simple backtest harness over the existing Yahoo daily bars would validate thresholds now.
- **Prediction page:** drop the 15% day-of-week/month seasonality weight (fitted noise); relabel ATR-projected "targets" as volatility ranges — they are not price objectives, so displayed R:R is synthetic.
- **Bestpicks universe bias:** z-scores are computed over the union of screener survivors — a "value z-score" relative to a momentum-selected pool is not value. The holdout logging in 2.3 fixes this too.

---

## 4. Data layer: what's missing for sound stock picking

Current inputs: prices/volume (Yahoo), delivery % (NSE bhavcopy), coarse Tickertape tags, macro, earnings dates. Missing, roughly in order of value:

1. **Real fundamentals** — EPS growth series, ROE/ROCE, D/E, margins. Quality currently rests on three High/Avg/Low tags.
2. **FII/DII daily flows + promoter holding/pledging + shareholding patterns** — NSE publishes these daily; same fetch difficulty as the bhavcopy already handled in `fetch-nse-delivery.js`.
3. **Bulk/block deals** — direct smart-money signal, free from NSE.
4. **Corporate-action awareness** — a split/bonus corrupts cached 3M ranges and stored pivots/stops in `trades-data.json`.

Robustness: `generate-prices.js` uses concurrency 50 with no backoff and swallows failures — a throttled run silently produces thin data that `generate-triggers.js` then treats as live (**no staleness check before confirming LIVE_BREAKOUT**). `lib/delivery.js`/`lib/earnings.js` have no staleness guards (regime/macro do). `fetch.js` relies on coordinate-based clicks and class-substring selectors — intercept Tickertape's XHR JSON responses instead.

---

## 5. Signals, exits, and alerts

**5.1 Entry (`lib/signals.js`):** beyond bug 1.1 — add a max-extension filter (skip if live price > pivot + ~0.5×ATR; chasing extended breaks widens absolute risk); enforce the defined-but-unused `maxPctPerSector: 20`; add an aggregate open-risk cap and ADV-based size cap.

**5.2 Exit engine (`monitor.js`):**
- EMA10 trail from day 1 is too tight for a 2×ATR-stop system — normal pullbacks fire STOP_HIT noise immediately after entry. Activate trailing only after +1R; use a chandelier stop from **highest high since entry** (the current ATR anchor is the static pivot, which never ratchets).
- Add a time stop (stagnant N weeks) and an earnings-within-7d warning/exit (data already exists).
- Add regime-aware tightening in bear.
- Log actual stop/target exits so `tuneSigning` in learn-weights optimizes the real trading rule (currently R-multiples are marked-to-horizon, not to exits).

**5.3 The 3M-low dip alert is a falling-knife catcher.** No trend filter, no regime gate (fires freely in bears — exactly when everything is near its 3M low); `rateBounce` *rewards* dip depth and low 52W position, and counts high-volume distribution as "accumulation"; the low ratchets down daily so a collapse re-alerts every 4h all the way down. Fix: gate on regime + uptrend/base structure, drop deeper-dip-is-better scoring, require delivery-surge or up-day volume confirmation (already computed in `docs/delivery.json`). Treat as a watch prompt, not an entry signal.

**5.4 Security:** Gmail app password in plaintext `config.json` (gitignored, but move to env/credential manager); `alert-system.js` stores a GitHub PAT in `localStorage` and commits client-side — any XSS on the published pages yields repo write access.

---

## 6. Suggested sequence

| Phase | Work | Why first |
|---|---|---|
| **Week 1** | All §1 bugs; earnings blackout in triggers; staleness check on live-prices before LIVE_BREAKOUT | Small diffs, immediate correctness |
| **Week 2–3** | Learning-loop fixes §2.1–2.3 (dedupe, Fama-MacBeth IC, holdout logging, censoring); reset learned weights to neutral afterward — current values were fitted on invalid statistics | Everything downstream trains on this data; every week delayed is a week of contaminated ledger |
| **Week 3–4** | Liquidity floor + ADV sizing; VCP/pivot rework in breakout2; exit-engine rework §5.2 | Direct trade-quality impact |
| **Month 2** | Consolidation §3.1 (retire v1/potential, unify fundamental engine, fold meta-pages); shared lib/technical.js; sector-relative scoring; exchange-wide RS | Halves maintenance surface, concentrates learning samples |
| **Month 2–3** | FII/DII + promoter/shareholding + bulk-deal ingestion; quarterly earnings factor; backtest harness; isotonic calibration once ≥50 distinct entry dates matured | The step-change in pick quality |

---

*One honest caveat: no scoring system — however well-engineered — guarantees profits; the learning loop can only ever tell you what worked recently. The fixes above make its answers honest, which is the most a system like this can promise.*
