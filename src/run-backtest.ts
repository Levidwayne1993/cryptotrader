// ============================================================
// PROJECT: cryptotrader
// FILE: src/run-backtest.ts (NEW FILE)
// DESCRIPTION: CLI runner for the backtesting engine.
//   Run from command line to test strategies against
//   historical Kraken data before risking real money.
//
// USAGE:
//   npx ts-node src/run-backtest.ts
//   npx ts-node src/run-backtest.ts --strategy day_trader --days 30
//   npx ts-node src/run-backtest.ts --strategy scalper --days 7 --pairs BTC/USD,ETH/USD
//   npx ts-node src/run-backtest.ts --strategy swing_trader --days 90 --limit-orders
//   npx ts-node src/run-backtest.ts --help
// ============================================================

import { BacktestEngine, BacktestConfig } from './backtest';
import { StrategyType } from './types';

// ============================================================
// PARSE COMMAND LINE ARGUMENTS
// ============================================================
function parseArgs(): {
  strategy: StrategyType;
  days: number;
  pairs: string[];
  balance: number;
  useLimitOrders: boolean;
  slippage: number;
  minTp: number;
  help: boolean;
} {
  const args = process.argv.slice(2);

  const defaults = {
    strategy: 'day_trader' as StrategyType,
    days: 14,
    pairs: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'ADA/USD', 'XRP/USD', 'DOT/USD', 'AVAX/USD', 'LINK/USD'],
    balance: 1000,
    useLimitOrders: false,
    slippage: 0.1,
    minTp: 2.0,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--strategy':
      case '-s':
        defaults.strategy = args[++i] as StrategyType;
        break;
      case '--days':
      case '-d':
        defaults.days = parseInt(args[++i]);
        break;
      case '--pairs':
      case '-p':
        defaults.pairs = args[++i].split(',').map(s => s.trim());
        break;
      case '--balance':
      case '-b':
        defaults.balance = parseFloat(args[++i]);
        break;
      case '--limit-orders':
      case '-l':
        defaults.useLimitOrders = true;
        break;
      case '--slippage':
        defaults.slippage = parseFloat(args[++i]);
        break;
      case '--min-tp':
        defaults.minTp = parseFloat(args[++i]);
        break;
      case '--help':
      case '-h':
        defaults.help = true;
        break;
    }
  }

  return defaults;
}

// ============================================================
// HELP TEXT
// ============================================================
function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           CryptoTrader Backtesting Engine                   ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Test your strategies against real historical Kraken data     ║
║  before risking real money.                                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

USAGE:
  npx ts-node src/run-backtest.ts [options]

OPTIONS:
  --strategy, -s <name>     Strategy to test (default: day_trader)
                            Options: day_trader, swing_trader, scalper,
                                     dca, contrarian, momentum

  --days, -d <number>       Number of days of history to test (default: 14)
                            More days = more data but slower to fetch

  --pairs, -p <list>        Comma-separated pairs to trade (default: all 9)
                            Example: BTC/USD,ETH/USD,SOL/USD

  --balance, -b <amount>    Starting balance in USD (default: 1000)

  --limit-orders, -l        Use limit orders (maker fee: 0.25%)
                            Default is market orders (taker fee: 0.40%)

  --slippage <percent>      Simulated slippage percent (default: 0.1)

  --min-tp <percent>        Minimum take profit floor (default: 2.0)

  --help, -h                Show this help text

EXAMPLES:
  # Quick test: day_trader strategy, last 7 days, all pairs
  npx ts-node src/run-backtest.ts -s day_trader -d 7

  # Test scalper on BTC and ETH only, 3 days
  npx ts-node src/run-backtest.ts -s scalper -d 3 -p BTC/USD,ETH/USD

  # Test swing trader over 90 days with $5000 balance
  npx ts-node src/run-backtest.ts -s swing_trader -d 90 -b 5000

  # Compare market vs limit orders
  npx ts-node src/run-backtest.ts -s day_trader -d 14
  npx ts-node src/run-backtest.ts -s day_trader -d 14 --limit-orders

  # Conservative test: high min TP, low slippage
  npx ts-node src/run-backtest.ts -s momentum -d 30 --min-tp 3.0 --slippage 0.05

NOTES:
  - Kraken limits OHLCV history to ~720 candles per request, so the
    engine fetches in chunks. Longer periods take more time.
  - Fear & Greed index uses current value (historical not available
    for free). Results may vary slightly from live performance.
  - The engine uses the SAME analysis engine, indicators, and
    position sizing as the live bot — so results are realistic.
  - Always test with slippage > 0 for realistic results.
`);
}

// ============================================================
// MAIN
// ============================================================
async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Validate strategy
  const validStrategies = ['day_trader', 'swing_trader', 'scalper', 'dca', 'contrarian', 'momentum'];
  if (!validStrategies.includes(args.strategy)) {
    console.error(`\n❌ Invalid strategy: "${args.strategy}"`);
    console.error(`   Valid options: ${validStrategies.join(', ')}\n`);
    process.exit(1);
  }

  // Validate days
  if (args.days < 1 || args.days > 365) {
    console.error(`\n❌ Days must be between 1 and 365 (got ${args.days})\n`);
    process.exit(1);
  }

  // Calculate date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - args.days);

  // Build config
  const config: BacktestConfig = {
    strategy: args.strategy,
    pairs: args.pairs,
    startDate,
    endDate,
    initialBalance: args.balance,
    takerFeeRate: 0.004,       // Kraken taker: 0.40%
    makerFeeRate: 0.0025,      // Kraken maker: 0.25%
    useLimitOrders: args.useLimitOrders,
    minTakeProfitPercent: args.minTp,
    slippagePercent: args.slippage,
  };

  console.log('\n🚀 Starting backtest...\n');

  try {
    const engine = new BacktestEngine(config);
    const result = await engine.run();

    // Print the formatted report
    BacktestEngine.printReport(result);

    // Exit cleanly
    process.exit(0);
  } catch (err: any) {
    console.error(`\n❌ Backtest failed: ${err.message}\n`);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run
main();
