// Second-Wind Dip-Recovery Bot v3-local (Early + Fast) — entrypoint.
//
// Reads the replay's market events as they arrive and decides when to buy,
// when to sell and how much to risk. All decisions live in strategy.ts;
// this file only wires the strategy into the harness shim and reports the
// final account to stderr when the replay ends.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone: (state, done) => {
    console.error(
      `done reason=${done.reason} cash=${state.cash} positions=${state.positions.size} curves=${state.curves.size}`,
    );
  },
});
