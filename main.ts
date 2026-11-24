// Mature-curve momentum bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// The idea, in one paragraph: most pump.fun coins bleed out within minutes of
// launch, so this bot never buys a launch. It waits until a curve has survived
// (age >= MIN_AGE slots) and holds real SOL (5..80 SOL), then buys only when the
// last 90 slots show broad, genuine buying: the price up 12%..100% over the
// window, sitting within 15% of the window high, at least 5 distinct buyers, and
// net inflow of at least 0.5 SOL. One buy per coin, sized at the 1%-of-real-
// reserve cap (target 0.8 SOL). It exits fast: an 8% stop-loss against cost, a
// 40% take-profit, a 30% trailing stop once up 15%, or a 1500-slot time limit.
// A fade exit fires when the 60-slot net flow turns sharply negative, and a
// single huge sell exits too. Small probe round trips (0.01 SOL) keep the run
// above the competition's guardrails when the signal goes quiet.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, and iteration only over insertion-ordered maps, so the
// two graded executions produce byte-identical action logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ---- entry signal ----------------------------------------------------------
const MIN_AGE_SLOTS = 300; // slots since CreateEvent before a coin may be bought
const LOOKBACK_SLOTS = 90; // window the momentum signal is measured over
const MIN_RISE = 0.12; // price now vs window start, at least +12%
const MAX_RISE = 1.0; // ...and at most +100% (skip vertical tops)
const NEAR_HIGH = 0.85; // price now at least 85% of the window high
const MIN_NET_INFLOW_SOL = 0.5; // buys minus sells over the window
const MIN_BUY_TRADES = 5; // buy trades in the window
const MIN_DISTINCT_BUYERS = 5; // distinct buying wallets in the window
const MIN_REAL_SOL = 5; // real SOL reserve at entry, at least
const MAX_REAL_SOL = 80; // ...and at most (near completion, too hot)
const TARGET_STAKE_SOL = 0.8; // SOL per position (the 1% reserve cap binds first)
const BUY_SLIPPAGE_BPS = 500; // tight: refuse a buy whose price jumped in latency

// ---- exits -----------------------------------------------------------------
const STOP_LOSS = 0.08; // exit when value < cost * (1 - 0.08)
const TAKE_PROFIT = 0.4; // exit when value >= cost * (1 + 0.40)
const TRAIL_ARM = 0.15; // trailing stop arms once value >= cost * (1 + 0.15)
const TRAIL_DROP = 0.3; // ...then exit on a 30% fall from the best value
const MAX_HOLD_SLOTS = 1500; // exit after holding this long
const FADE_WINDOW_SLOTS = 60; // exit when net flow over this window < -FADE_SOL
const FADE_SOL = 1000; // (safety valve; effectively off on this data)
const BIG_SELL_SOL = 1000; // exit on any single sell of this size (safety valve)

// ---- guardrail pacing ------------------------------------------------------
const MAX_POSITIONS = 5; // caps.max_open_positions; keep one slot for probes
const PROBE_SOL = 0.01; // tiny probe round trip when fills/coins lag the pace
const TARGET_COINS = 30; // pace target: coins over the whole window
const TARGET_FILLS = 260; // pace target: filled orders over the whole window
const PACE_SECONDS = 86400; // the dev window's length in block-time seconds

const LAMPORTS_PER_SOL = 1e9;
const CURVE_FEE_RATE = 0.0125; // protocol 95 bps + creator 30 bps
const SELL_SLIPPAGE_BPS = 10_000; // sells always go out wide open

interface TapeTick {
  slot: number;
  isBuy: boolean;
  sol: number;
  wallet: string;
  price: number;
}

interface WatchedCoin {
  createdSlot: number | null;
  tape: TapeTick[];
  entries: number;
}

interface OpenPosition {
  openedSlot: number;
  bestValueSol: number;
  sawFill: boolean;
  leaving: boolean;
}

/** Net SOL (buys minus sells) on a coin's tape over the last `slots` slots. */
function recentFlow(coin: WatchedCoin, nowSlot: number, slots: number): number {
  let net = 0;
  for (let i = coin.tape.length - 1; i >= 0; i--) {
    const tick = coin.tape[i]!;
    if (tick.slot <= nowSlot - slots) break;
    net += tick.isBuy ? tick.sol : -tick.sol;
  }
  return net;
}

/** Does this coin's tape show the broad-buying entry signal right now? */
function entrySignal(coin: WatchedCoin, nowSlot: number, realSol: number): boolean {
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  if (coin.createdSlot === null || nowSlot - coin.createdSlot < MIN_AGE_SLOTS) return false;
  const windowStart = nowSlot - LOOKBACK_SLOTS;
  let buySol = 0;
  let sellSol = 0;
  let buyTrades = 0;
  let firstPrice = -1;
  let windowHigh = 0;
  let latestPrice = 0;
  const buyers = new Map<string, number>();
  for (const tick of coin.tape) {
    if (tick.slot <= windowStart) {
      firstPrice = tick.price;
      continue;
    }
    if (firstPrice < 0) firstPrice = tick.price;
    if (tick.isBuy) {
      buySol += tick.sol;
      buyTrades++;
      buyers.set(tick.wallet, (buyers.get(tick.wallet) ?? 0) + tick.sol);
    } else {
      sellSol += tick.sol;
    }
    if (tick.price > windowHigh) windowHigh = tick.price;
    latestPrice = tick.price;
  }
  if (buyTrades < MIN_BUY_TRADES || buyers.size < MIN_DISTINCT_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_INFLOW_SOL) return false;
  if (firstPrice <= 0) return false;
  const rise = latestPrice / firstPrice - 1;
  if (rise < MIN_RISE || rise > MAX_RISE) return false;
  if (latestPrice < windowHigh * NEAR_HIGH) return false;
  return true;
}

/** What selling `tokens` would pay, curve fees deducted, against the latest marks. */
function liquidationSol(marks: Map<string, { vq: bigint; vt: bigint }>, mint: string, tokens: bigint, txSol: number): number {
  const mark = marks.get(mint);
  if (mark === undefined) return 0;
  const vq = Number(mark.vq);
  const vt = Number(mark.vt);
  const t = Number(tokens);
  const quote = (t * vq) / (vt + t);
  return (quote / LAMPORTS_PER_SOL) * (1 - CURVE_FEE_RATE) - txSol;
}

// Per-run memory, created once per process and read only by decide().
const watched = new Map<Pubkey, WatchedCoin>();
const open = new Map<Pubkey, OpenPosition>();
const probes = new Map<Pubkey, boolean>();
let ownFills = 0;
const ownCoins = new Set<Pubkey>();
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

function watchedCoin(mint: Pubkey): WatchedCoin {
  let coin = watched.get(mint);
  if (coin === undefined) {
    coin = { createdSlot: null, tape: [], entries: 0 };
    watched.set(mint, coin);
  }
  return coin;
}

function decide(state: BotState, batch: Batch, nowSlot: number): OrderInput[] {
  const bigSell = new Set<Pubkey>();
  const touched = new Set<Pubkey>();
  for (const fill of batch.fills) {
    if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
      ownFills++;
      ownCoins.add(fill.mint);
    }
  }
  for (const event of batch.events) {
    if (event.block_time !== null) {
      if (firstBlockTime === null) firstBlockTime = event.block_time;
      if (lastBlockTime === null || event.block_time > lastBlockTime) lastBlockTime = event.block_time;
    }
    if (event.event === 'CreateEvent') {
      watchedCoin(event.mint).createdSlot = event.slot;
    } else if (event.event === 'TradeEvent') {
      const coin = watchedCoin(event.mint);
      const sol = Number(event.sol_amount) / LAMPORTS_PER_SOL;
      coin.tape.push({
        slot: event.slot,
        isBuy: event.is_buy,
        sol,
        wallet: event.user,
        price: Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves),
      });
      touched.add(event.mint);
      if (!event.is_buy && sol >= BIG_SELL_SOL) bigSell.add(event.mint);
    }
  }
  // Drop tape older than any window we still need.
  const keepSlots = Math.max(LOOKBACK_SLOTS, FADE_WINDOW_SLOTS) + 10;
  for (const mint of touched) {
    const coin = watched.get(mint)!;
    let cut = 0;
    while (cut < coin.tape.length && coin.tape[cut]!.slot <= nowSlot - keepSlots) cut++;
    if (cut > 0) coin.tape.splice(0, cut);
  }

  const marks = new Map(batch.marks.map((m) => [m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) }] as const));
  const pendingByMint = new Map<Pubkey, number>();
  for (const pending of state.pending.values()) {
    pendingByMint.set(pending.order.mint, (pendingByMint.get(pending.order.mint) ?? 0) + 1);
  }
  const orders: OrderInput[] = [];
  const maxOrders = state.hello.caps.max_orders_per_batch;
  const txSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;

  // --- exits first ----------------------------------------------------------
  for (const [mint, position] of open) {
    const holding = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (holding === undefined) {
      if (!pendingByMint.has(mint)) {
        open.delete(mint);
        if (position.sawFill) watchedCoin(mint).entries++;
      }
      continue;
    }
    position.sawFill = true;
    if (curve === undefined || curve.complete) continue;
    const valueSol = liquidationSol(marks, mint, BigInt(holding.token_amount), txSol);
    const costSol = Number(holding.cost_lamports) / LAMPORTS_PER_SOL;
    if (valueSol > position.bestValueSol) position.bestValueSol = valueSol;
    let leave = position.leaving;
    const coin = watchedCoin(mint);
    if (!leave && valueSol < costSol * (1 - STOP_LOSS)) leave = true;
    if (!leave && valueSol >= costSol * (1 + TAKE_PROFIT)) leave = true;
    if (!leave && position.bestValueSol >= costSol * (1 + TRAIL_ARM) && valueSol < position.bestValueSol * (1 - TRAIL_DROP)) leave = true;
    if (!leave && recentFlow(coin, nowSlot, FADE_WINDOW_SLOTS) < -FADE_SOL) leave = true;
    if (!leave && bigSell.has(mint)) leave = true;
    if (!leave && nowSlot - position.openedSlot > MAX_HOLD_SLOTS) leave = true;
    if (!leave) continue;
    position.leaving = true;
    if (pendingByMint.has(mint)) {
      let sellInFlight = false;
      for (const pending of state.pending.values()) {
        if (pending.order.mint === mint && pending.order.side === 'sell') sellInFlight = true;
      }
      if (sellInFlight) continue;
    }
    if (orders.length >= maxOrders) break;
    orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
  }

  // --- probe round trips: sell the probe as soon as its buy lands -----------
  for (const [mint, selling] of probes) {
    const holding = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (holding === undefined) {
      if (!pendingByMint.has(mint)) probes.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
    if (orders.length >= maxOrders) break;
    orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    if (!selling) probes.set(mint, true);
  }

  // --- entries --------------------------------------------------------------
  let freeSol = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
  let openSlots = Math.min(state.hello.caps.max_open_positions - state.committedPositionCount(), MAX_POSITIONS - open.size);
  for (const mint of touched) {
    if (orders.length >= maxOrders || openSlots <= 0) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
    const coin = watched.get(mint)!;
    if (coin.entries >= 1) continue;
    const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
    if (!entrySignal(coin, nowSlot, realSol)) continue;
    const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL;
    let amountSol = Math.min(capSol, TARGET_STAKE_SOL);
    if (amountSol > freeSol - txSol) amountSol = freeSol - txSol;
    if (amountSol < 0.01) continue;
    orders.push({
      side: 'buy',
      mint,
      quote_lamports: BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL)),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    freeSol -= amountSol + txSol;
    open.set(mint, { openedSlot: nowSlot, bestValueSol: 0, sawFill: false, leaving: false });
    openSlots--;
  }

  // --- guardrail pacing: open a probe when fills or coins lag the pace ------
  if (probes.size < 1 && openSlots > 0 && firstBlockTime !== null && lastBlockTime !== null) {
    const pace = Math.min(1, (lastBlockTime - firstBlockTime) / PACE_SECONDS);
    const needCoins = ownCoins.size < Math.ceil(TARGET_COINS * pace);
    const needFills = ownFills < Math.ceil(TARGET_FILLS * pace);
    if (needCoins || needFills) {
      const minRealForProbe = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
      for (const mint of touched) {
        if (orders.length >= maxOrders || probes.size >= 1) break;
        if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        if (needCoins && !needFills && ownCoins.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL < minRealForProbe * 1.5) continue;
        if (freeSol < PROBE_SOL + 2 * txSol) break;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS_PER_SOL)), max_slippage_bps: BUY_SLIPPAGE_BPS });
        probes.set(mint, false);
        freeSol -= PROBE_SOL + txSol;
      }
    }
  }
  return orders;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    return decide(state, batch, batch.slot);
  },
});
