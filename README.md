# Mature Momentum — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Hasanrdp/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Hasanrdp/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It replays on 6 hours of real pump.fun bonding-curve data; the highest net PnL wins.

## Strategy

Most pump.fun coins bleed out within minutes of launch, so this bot never buys
a launch. It waits until a curve has survived (age ≥ 300 slots) and holds real
SOL (5–80 SOL), then buys only when the last 90 slots show broad, genuine
buying: price up 12%–100% over the window, sitting within 15% of the window
high, at least 5 distinct buyers, and net inflow of at least 0.5 SOL. One buy
per coin, sized at the 1%-of-real-reserve cap (target 0.8 SOL).

Exits are fast: an 8% stop-loss against cost, a 40% take-profit, a 30%
trailing stop once up 15%, or a 1500-slot time limit. A fade exit fires when
the 60-slot net flow turns sharply negative, and a single huge sell exits too.
Tiny 0.01 SOL probe round trips keep the run above the guardrails when the
signal goes quiet.

## Local results (dev window, `grade-local --driver process`)

- Net PnL: **+1.472 SOL** (return +14.7%, 90% interval +0.29 … +2.73 SOL)
- 275 fills over 128 coins, 138 round trips, win rate 24.6%
- Max drawdown 2.8%; guardrails met (128 coins ≥ 20, drawdown ≤ 50%)
- At 2× fees: still +0.797 SOL; without the top 3 coins: +0.68 SOL
- Determinism: two executions reproduce byte for byte (L1 regrade)

## Layout

- `main.ts` — the strategy (Node 22, runs as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's replay-v2 SDK shim, vendored byte for byte
- `.makefun/owner.json` — payout wallet claim file
- `LICENSE` — MIT

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```
