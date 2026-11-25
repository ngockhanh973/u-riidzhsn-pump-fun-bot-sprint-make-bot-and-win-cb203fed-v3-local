[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v3-local/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ngockhanh973/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-v3-local/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Second-Wind Dip-Recovery Bot v3-local (Early + Fast)

A paper-trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It trades on a replay of real pump.fun bonding-curve events and is scored on net PnL over a 6-hour final window.

## Strategy

Most fresh curves rug or fade. This bot does not chase them. It waits for a coin that has already proven it can run — price at least doubled from creation — and then buys the dip: price pulled back to 75–92% of its peak while buyers are flowing back in (at least 3 buys from 3 distinct wallets in the last 15 slots, net flow ≥ 0.02 SOL, latest trade a buy, no single buyer over half the window's buy volume). A coin whose creator has sold ≥ 0.5 SOL in total is vetoed forever.

v3 ("Early + Fast") moves earlier and exits faster than the v2 baseline: first entry from slot 100, a wider dip band, TP1 at +10% with a 7% trailing stop, a 10% stop-loss and a 500-slot max hold (doubled while up ≥ 20%).

- **Entry:** 0.05 SOL first buy; one 0.10 SOL add when price runs 5% past the first buy with flow still positive. Max 2 lifetime entries per coin, 150-slot cooldown after an exit, max 5 open positions, max 3.5 SOL total exposure.
- **Exits (checked before any new entry each batch):** sell everything on creator veto, stop-loss, trailing stop after TP1, TP2 at +50%, fading flow (15-slot net < −0.05 SOL), or max hold. Sell half once at TP1.
- **Pacing probes:** tiny 0.01 SOL probes keep the bot on pace toward 22 coins / 100 fills over the 4-hour pacing window, sold as soon as the buy fills.

## Parameters (v3)

`minRunup 2.0 · minAge 100 · dip 0.75–0.92 · flowWindow 15 · minFlowSol 0.02 · minFlowBuyers 3 · tp1 0.10 · tp2 0.50 · trail 0.07 · stopLoss 0.10 · maxHold 500 · holdIfUp 0.20 · cooldown 150 · maxEntries 2 · maxMain 5 · creatorSellVetoSol 0.5 · maxExposureSol 3.5 · firstSol 0.05 · addSol 0.10 · maxPositionSol 0.30 · probeSol 0.01 · targetCoins 22 · targetFills 100 · paceSecs 14400`

## Layout

- `main.ts` — entrypoint: wires the strategy into the harness shim.
- `strategy.ts` — the whole strategy (params + decision logic).
- `vendor/makefun-bot.ts` — the kit's bot shim, copied byte-identical.

## Running the dev-window sim

From the kit's `baselines/pilot/momentum/tools/` port (local engine, no Docker):

```sh
node tools/backtest.ts <kit dir>
```

## Dev-window results

Measured with the kit's local engine port on the frozen dev window (two
identical runs — fully deterministic):

- **Net PnL: −0.185699 SOL** · fills 144 · coins 39 · trips 69 · wins 3 · max drawdown 0.0186 · rejected 0 · failed 3
- Without failed txs: −0.185384 SOL · at 2× fees: −0.240783 SOL
- Guardrails: coins 39 ≥ 20 ✓, drawdown 0.0186 ≤ 0.50 ✓
- v2 baseline on the same window: −0.084910 SOL — v3 is **0.100789 SOL worse** on dev. The earlier entries and faster exits trade more (144 vs 129 fills) but lock in small losses sooner; the dev window does not reward this variant. The final window is fresh tape, so this is a dev-window observation, not a final verdict.
