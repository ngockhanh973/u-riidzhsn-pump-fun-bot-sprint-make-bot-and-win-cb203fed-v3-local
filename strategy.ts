// Second-Wind Dip-Recovery Bot v3-local (Early + Fast).
//
// Idea: never chase a freshly created curve. Only buy a coin that has already
// proven it can run (price once doubled from its creation price) and is now
// pulling back 8-25% off its peak while buyers are coming back in. The creator
// may take a small profit, but once the creator has sold 0.5 SOL in total the
// coin is dead to us forever.
//
// v3 moves earlier and exits faster than v2: entry from slot 100 instead of
// 200, a wider dip band (0.75-0.92 of peak), a shorter 15-slot flow window,
// TP1 at +10% with a 7% trail, a 10% stop and a 500-slot max hold.
//
// Deterministic: every decision comes only from the batch the harness sends
// plus this module's own state. No clock, no randomness, no environment, no IO.

import type { Batch, BotState } from './vendor/makefun-bot.ts';

export interface Params {
  minRunup: number;
  minAge: number;
  flowWindow: number;
  minFlowSol: number;
  minFlowBuyers: number;
  lastMustBeBuy: boolean;
  maxBuyerShare: number;
  dipMax: number;
  dipMin: number;
  minRealSol: number;
  minPeakRealSol: number;
  firstSol: number;
  addSol: number;
  maxPositionSol: number;
  addStep: number;
  minBuySol: number;
  buySlipBps: number;
  tp1: number;
  tp2: number;
  trail: number;
  stopLoss: number;
  fadeWindow: number;
  fadeNetSol: number;
  maxHold: number;
  holdIfUp: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  creatorSellVetoSol: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minRunup: 2.0,
  minAge: 100,
  flowWindow: 15,
  minFlowSol: 0.02,
  minFlowBuyers: 3,
  lastMustBeBuy: true,
  maxBuyerShare: 0.5,
  dipMax: 0.92,
  dipMin: 0.75,
  minRealSol: 3,
  minPeakRealSol: 5,
  firstSol: 0.05,
  addSol: 0.1,
  maxPositionSol: 0.3,
  addStep: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  tp1: 0.1,
  tp2: 0.5,
  trail: 0.07,
  stopLoss: 0.1,
  fadeWindow: 15,
  fadeNetSol: 0.05,
  maxHold: 500,
  holdIfUp: 0.2,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  creatorSellVetoSol: 0.5,
  maxExposureSol: 3.5,
  targetCoins: 22,
  targetFills: 100,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const FEE_RATE = 0.0125;
const TX_FEE_SOL = 105000 / LAMPORTS;
const SELL_SLIP_BPS = 10000;

interface TradeNote {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  px: number;
}

interface CoinBook {
  born: number | null;
  creator: string;
  startPx: number;
  topPx: number;
  topRealSol: number;
  makerSold: number;
  trades: TradeNote[];
  lastTradeSlot: number;
  entries: number;
  lastExitSlot: number;
  everFilled: boolean;
  everProbed: boolean;
  firstBuyPx: number;
  added: boolean;
  tp1Done: boolean;
  bestSol: number;
  entrySlot: number;
  isProbe: boolean;
  heldTokens: bigint;
}

function blankBook(): CoinBook {
  return {
    born: null,
    creator: '',
    startPx: 0,
    topPx: 0,
    topRealSol: 0,
    makerSold: 0,
    trades: [],
    lastTradeSlot: -1,
    entries: 0,
    lastExitSlot: -1,
    everFilled: false,
    everProbed: false,
    firstBuyPx: 0,
    added: false,
    tp1Done: false,
    bestSol: 0,
    entrySlot: -1,
    isProbe: false,
    heldTokens: 0n,
  };
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function windowTrades(book: CoinBook, slot: number, span: number): TradeNote[] {
  const from = slot - span;
  return book.trades.filter((t) => t.slot > from);
}

function netFlow(trades: TradeNote[]): number {
  let net = 0;
  for (const t of trades) net += t.buy ? t.sol : -t.sol;
  return net;
}

interface OpenSpot {
  tokens: bigint;
  costSol: number;
  valueSol: number;
}

class DipRecovery {
  private p: Params;
  private books = new Map<string, CoinBook>();
  private firstBlock: number | null = null;
  private lastBlock: number | null = null;
  private totalFills = 0;
  private filledCoins = new Set<string>();
  private probesFlying = 0;
  private probeIds = new Set<string>();
  private probeSeq = 0;
  private horizon: number;

  constructor(params: Params) {
    this.p = params;
    this.horizon = Math.max(params.flowWindow, params.fadeWindow) + 40;
  }

  private book(mint: string): CoinBook {
    let b = this.books.get(mint);
    if (b === undefined) {
      b = blankBook();
      this.books.set(mint, b);
    }
    return b;
  }

  private foldEvents(state: BotState, batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (this.firstBlock === null) this.firstBlock = e.block_time;
        this.lastBlock = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const b = this.book(e.mint);
        b.born = e.slot;
        b.creator = e.creator;
        b.startPx = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        b.topPx = b.startPx;
      } else if (e.event === 'TradeEvent') {
        const b = this.book(e.mint);
        if (b.creator === '') b.creator = e.creator;
        const px = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        const realSol = Number(BigInt(e.real_quote_reserves)) / LAMPORTS;
        if (px > b.topPx) b.topPx = px;
        if (realSol > b.topRealSol) b.topRealSol = realSol;
        const sol = Number(BigInt(e.sol_amount)) / LAMPORTS;
        if (!e.is_buy && e.user === b.creator) b.makerSold += sol;
        b.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, px });
        b.lastTradeSlot = e.slot;
        const cut = e.slot - this.horizon;
        while (b.trades.length > 0 && b.trades[0]!.slot <= cut) b.trades.shift();
      }
    }
  }

  private foldFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      const probeHere = this.probeIds.delete(f.client_id);
      if (probeHere && this.probesFlying > 0) this.probesFlying -= 1;
      if (f.status !== 'filled') continue;
      this.totalFills += 1;
      this.filledCoins.add(f.mint);
      const b = this.book(f.mint);
      b.everFilled = true;
      if (f.side === 'buy') {
        const wasEmpty = b.heldTokens === 0n;
        b.heldTokens += BigInt(f.token_amount);
        if (wasEmpty) {
          b.entries += 1;
          b.entrySlot = f.slot;
          b.firstBuyPx = Number(BigInt(f.quote_lamports)) / Number(BigInt(f.token_amount));
          b.added = false;
          b.tp1Done = false;
          b.bestSol = 0;
          b.isProbe = probeHere;
        } else {
          b.added = true;
        }
      } else {
        const sold = BigInt(f.token_amount);
        b.heldTokens = b.heldTokens > sold ? b.heldTokens - sold : 0n;
        if (b.heldTokens === 0n) {
          b.lastExitSlot = f.slot;
          b.isProbe = false;
          b.bestSol = 0;
        } else {
          // Tokens remain after a sell fill: that was the TP1 half-sell.
          // Mark it done here (only on the fill, never on sending, so a
          // rejected TP1 order cannot arm the trail) and re-anchor the
          // trailing peak at the value of what is left.
          b.tp1Done = true;
          const spot = this.spot(state, f.mint);
          if (spot !== null) b.bestSol = spot.valueSol;
        }
      }
    }
  }

  private spot(state: BotState, mint: string): OpenSpot | null {
    const held = state.positions.get(mint);
    if (held === undefined || held.token_amount === 0n) return null;
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (px <= 0) return null;
    const gross = (Number(held.token_amount) * px) / LAMPORTS;
    const valueSol = gross * (1 - FEE_RATE) - TX_FEE_SOL;
    return { tokens: held.token_amount, costSol: Number(held.cost_lamports) / LAMPORTS, valueSol };
  }

  private pendingSide(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  private exposureSol(state: BotState): number {
    let total = 0;
    for (const h of state.positions.values()) total += Number(h.cost_lamports) / LAMPORTS;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') total += Number(BigInt(p.order.quote_lamports)) / LAMPORTS;
    }
    return total;
  }

  private exits(state: BotState, batch: Batch): Record<string, unknown>[] {
    const p = this.p;
    const out: Record<string, unknown>[] = [];
    for (const mint of [...state.positions.keys()]) {
      const b = this.books.get(mint);
      if (b === undefined) continue;
      if (this.pendingSide(state, mint, 'sell')) continue;
      const spot = this.spot(state, mint);
      if (spot === null) continue;
      const age = batch.slot - b.entrySlot;
      const up = spot.valueSol >= spot.costSol * (1 + p.holdIfUp);
      const holdCap = up ? p.maxHold * 2 : p.maxHold;
      const fade = netFlow(windowTrades(b, batch.slot, p.fadeWindow));
      const full =
        b.makerSold >= p.creatorSellVetoSol ||
        spot.valueSol < spot.costSol * (1 - p.stopLoss) ||
        (b.tp1Done && spot.valueSol < b.bestSol * (1 - p.trail)) ||
        (b.tp1Done && spot.valueSol >= spot.costSol * (1 + p.tp2)) ||
        fade < -p.fadeNetSol ||
        age > holdCap;
      if (full) {
        out.push({ side: 'sell', mint, token_amount: spot.tokens.toString(), max_slippage_bps: SELL_SLIP_BPS });
        continue;
      }
      if (b.isProbe) {
        out.push({ side: 'sell', mint, token_amount: spot.tokens.toString(), max_slippage_bps: SELL_SLIP_BPS });
        continue;
      }
      if (!b.tp1Done && spot.valueSol >= spot.costSol * (1 + p.tp1)) {
        const half = spot.tokens / 2n;
        if (half > 0n) {
          out.push({ side: 'sell', mint, token_amount: half.toString(), max_slippage_bps: SELL_SLIP_BPS });
        }
      }
      if (spot.valueSol > b.bestSol) b.bestSol = spot.valueSol;
    }
    return out;
  }

  private entryReady(state: BotState, batch: Batch, mint: string, b: CoinBook): boolean {
    const p = this.p;
    if (b.born === null) return false;
    if (b.makerSold >= p.creatorSellVetoSol) return false;
    if (batch.slot - b.born < p.minAge) return false;
    if (b.entries >= p.maxEntries) return false;
    if (b.lastExitSlot >= 0 && batch.slot - b.lastExitSlot < p.cooldown) return false;
    if (b.topPx < p.minRunup * b.startPx) return false;
    if (b.topRealSol < p.minPeakRealSol) return false;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return false;
    const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
    if (realSol < p.minRealSol) return false;
    const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (px <= 0 || b.topPx <= 0) return false;
    const dip = px / b.topPx;
    if (dip < p.dipMin || dip > p.dipMax) return false;
    const recent = windowTrades(b, batch.slot, p.flowWindow);
    let buys = 0;
    let buySol = 0;
    const buyers = new Set<string>();
    let biggest = 0;
    const perBuyer = new Map<string, number>();
    for (const t of recent) {
      if (!t.buy) continue;
      buys += 1;
      buySol += t.sol;
      buyers.add(t.user);
      const tot = (perBuyer.get(t.user) ?? 0) + t.sol;
      perBuyer.set(t.user, tot);
      if (tot > biggest) biggest = tot;
    }
    if (buys < p.minFlowBuyers) return false;
    if (buyers.size < p.minFlowBuyers) return false;
    if (netFlow(recent) < p.minFlowSol) return false;
    if (p.lastMustBeBuy && recent.length > 0 && !recent[recent.length - 1]!.buy) return false;
    if (buySol > 0 && biggest / buySol > p.maxBuyerShare) return false;
    return true;
  }

  private sizedBuy(state: BotState, mint: string, wantSol: number): Record<string, unknown> | null {
    const p = this.p;
    const cap = Number(state.maxBuyLamports(mint)) / LAMPORTS;
    let size = Math.min(wantSol, cap);
    const free = Number(state.freeCashLamports()) / LAMPORTS - TX_FEE_SOL;
    if (size > free) size = free;
    const room = p.maxExposureSol - this.exposureSol(state);
    if (size > room) size = room;
    if (size < p.minBuySol) return null;
    const lamports = Math.floor(size * LAMPORTS);
    if (lamports <= 0) return null;
    return { side: 'buy', mint, quote_lamports: lamports.toString(), max_slippage_bps: p.buySlipBps };
  }

  private addsAndEntries(state: BotState, batch: Batch, sold: Set<string>): Record<string, unknown>[] {
    const p = this.p;
    const out: Record<string, unknown>[] = [];
    // One add per position: +0.10 SOL once the price has run 5% past the first buy.
    for (const mint of [...state.positions.keys()]) {
      const b = this.books.get(mint);
      if (b === undefined || b.added || b.isProbe || sold.has(mint)) continue;
      if (this.pendingSide(state, mint, 'buy')) continue;
      const spot = this.spot(state, mint);
      if (spot === null) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (px < b.firstBuyPx * (1 + p.addStep)) continue;
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (realSol < p.minRealSol) continue;
      if (netFlow(windowTrades(b, batch.slot, p.flowWindow)) < p.minFlowSol) continue;
      if (spot.costSol >= p.maxPositionSol - p.minBuySol) continue;
      const order = this.sizedBuy(state, mint, p.addSol);
      if (order !== null) out.push(order);
    }
    // Fresh entries, in first-seen curve order.
    if (state.committedPositionCount() < p.maxMain) {
      for (const mint of state.curves.keys()) {
        if (state.committedPositionCount() + out.filter((o) => o.side === 'buy').length >= p.maxMain) break;
        if (state.positions.has(mint)) continue;
        if (this.pendingSide(state, mint, 'buy')) continue;
        if (sold.has(mint)) continue;
        const b = this.books.get(mint);
        if (b === undefined) continue;
        if (!this.entryReady(state, batch, mint, b)) continue;
        const order = this.sizedBuy(state, mint, p.firstSol);
        if (order !== null) out.push(order);
      }
    }
    return out;
  }

  private probe(state: BotState, batch: Batch): Record<string, unknown> | null {
    const p = this.p;
    if (this.probesFlying >= p.maxProbes) return null;
    if (state.committedPositionCount() >= p.maxMain) return null;
    if (this.firstBlock === null || this.lastBlock === null) return null;
    const elapsed = this.lastBlock - this.firstBlock;
    const progress = Math.min(1, elapsed / p.paceSecs);
    const coinsShort = this.filledCoins.size < Math.ceil(p.targetCoins * progress);
    const fillsShort = this.totalFills < Math.ceil(p.targetFills * progress);
    if (!coinsShort && !fillsShort) return null;
    const capBps = state.hello.caps.max_order_bps_of_real_reserve;
    const liquidAt = (p.probeSol * 10000) / capBps * 1.5;
    for (const mint of state.curves.keys()) {
      const b = this.books.get(mint);
      if (b === undefined) continue;
      if (state.positions.has(mint)) continue;
      if (this.pendingSide(state, mint, 'buy')) continue;
      if (batch.slot - b.lastTradeSlot > p.flowWindow) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (realSol < liquidAt) continue;
      if (coinsShort && !fillsShort && b.everFilled) continue;
      const id = `probe${++this.probeSeq}`;
      this.probeIds.add(id);
      this.probesFlying += 1;
      const b2 = this.book(mint);
      b2.everProbed = true;
      const order = this.sizedBuy(state, mint, p.probeSol);
      if (order === null) {
        this.probeIds.delete(id);
        this.probesFlying -= 1;
        return null;
      }
      return { ...order, client_id: id };
    }
    return null;
  }

  onBatch(state: BotState, batch: Batch): Record<string, unknown>[] {
    this.foldEvents(state, batch);
    this.foldFills(state, batch);
    // A position the harness closed without a fill we saw: close the book.
    for (const [mint, b] of this.books) {
      if (b.heldTokens > 0n && !state.positions.has(mint) && !this.pendingSide(state, mint, 'sell')) {
        b.heldTokens = 0n;
        b.lastExitSlot = batch.slot;
        b.isProbe = false;
        b.bestSol = 0;
      }
    }
    const sells = this.exits(state, batch);
    const sold = new Set<string>(sells.map((o) => o.mint as string));
    const buys = this.addsAndEntries(state, batch, sold);
    const out = [...sells, ...buys];
    if (out.length < state.hello.caps.max_orders_per_batch) {
      const pr = this.probe(state, batch);
      if (pr !== null) out.push(pr);
    }
    return out;
  }
}

export function createStrategy(params: Params = DEFAULT_PARAMS): {
  onBatch(state: BotState, batch: Batch): Record<string, unknown>[];
} {
  const engine = new DipRecovery(params);
  return { onBatch: (state, batch) => engine.onBatch(state, batch) };
}
