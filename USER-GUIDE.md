# Simple User Guide — How to Trade with Your Pages

*Everything updates automatically every 10 minutes during market hours. You just read and decide.*

---

## The 5-minute daily routine

**1. Start at `hub.html`** — it links to everything.

**2. Check the market first (30 seconds).**
Every page shows a colored bar at the top: 🐂 **BULL** or 🐻 **BEAR**.
In BEAR mode the system automatically gets pickier — fewer triggers, tighter rules. If it's bear, trade smaller or not at all. Don't fight it.

**3. Open `triggers.html` — this is your BUY page.**
Everything else is research; this page is the only one that says "buy now, at this price."
A stock appears here only when it has already passed every filter: strong trend, tight base, real breakout, enough liquidity, no earnings due within 5 days.

Each row gives you the complete trade — copy it as-is:

| Column | What you do with it |
|---|---|
| **Entry** | The price to buy at (or below) |
| **Stop** | Your exit if it goes wrong. Set this as a stop-loss order the moment you buy. Never skip it. |
| **Target** | Where to start booking profits |
| **Size%** | How much of your portfolio to put in — already calculated so a stop-out costs you only ~1% |
| **Conviction** | Higher = more screeners agree. Prefer Elite/High tier rows |

Signal badges: 🟢 **LIVE break** = happening right now (best). ✅ **Valid EOD** = broke out yesterday and held (good). 🌊 **Surge** = volume spike (watch closely).

**4. Check your email.** The system mails you breakout alerts and — if you've entered your positions in `trades.html` — exit alerts (stop hit, take profit, earnings coming, position going nowhere). These emails are your safety net; act on them.

That's the whole routine.

---

## When you want to research more (optional, weekly)

| Page | One-line purpose | When to open it |
|---|---|---|
| **bestpicks.html** | The master ranking — blends every screener into one 0–100 score | Weekend review, building a shortlist |
| **breakout2.html** | Setups still *forming* (not triggered yet) | To see what may hit triggers soon |
| **apex.html** | Deep quality check: profits, growth, debt, promoters | Before a big-size trade — is the business good? |
| **sectors.html** | Which sectors are hot or turning | To favor stocks in leading sectors |
| **multibagger.html** | Long-term compounder candidates | Investing money, not trading money |
| **rocket.html** | Aggressive small/mid-cap momentum | Only in BULL mode, only small size |
| **alerts.html / index.html** | Your watchlist dips and dashboard | Your Tickertape stocks near lows |
| **trades.html** | **Enter every trade you take here** | The exit engine can only protect positions it knows about |

Ignore the rest day-to-day. More pages ≠ more profit.

---

## The rules that protect you

1. **Always set the stop.** The stop on the trigger card is not a suggestion — it's the trade. No stop, no trade.
2. **Respect Size%.** Never "round up" because you feel confident. One position should never be able to hurt you.
3. **Log the trade in `trades.html`** right after buying. Then the system watches it for you: trails your stop up as the stock rises, warns before earnings, tells you when to book 25% (+1.5R) and 50% (+2R).
4. **Don't buy stocks that ran far past their entry.** If price is well above the listed entry, you missed it — the system already skips over-extended ones; you should too. Another trigger always comes.
5. **BEAR banner = defense.** Smaller positions, faster profit-taking, more cash. The system tightens automatically; you tighten too.
6. **A "winProb" number is only trustworthy once the system says it's calibrated.** For the next few months, treat it as a rough guide, not a promise. The system is still collecting evidence on itself — that's by design.

---

## What "self-learning" means for you

Every pick is logged and checked 20 days later against the Nifty. Screeners that prove themselves slowly get more weight; ones that don't get less. You don't have to do anything — but expect the system to say "insufficient data" a lot in the early months. That's honesty, not failure.

---

## Monthly (2 minutes)

Run `npm run readiness` in the project folder. It tells you how the learning data is maturing and when we're ready to build the next-generation model. I'll also check in on this automatically.

---

*Not financial advice. The system finds and sizes candidates with discipline — the decision and the risk are always yours.*
