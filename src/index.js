require("dotenv").config();
const http = require("http");

const { DEFAULT_SETTINGS, CHAINS } = require("./config");
const ArbitrageStrategy = require("./strategies/arbitrage");
const CopyTradeStrategy = require("./strategies/copytrade");
const SandwichStrategy = require("./strategies/sandwich");
const TelegramBot = require("./telegram/bot");

async function main() {
  console.log("🚀 Starting MEV Bot...");

  // Runtime settings (mutable)
  const settings = { ...DEFAULT_SETTINGS };

  // Initialize Telegram bot first for notifications
  let telegramNotify = (msg) => console.log(`[NOTIFY] ${msg}`);

  // Initialize strategies per chain
  const strategies = {
    arbitrage: null,
    copytrade: null,
    sandwich: null,
  };

  // Initialize active chain strategies
  function initStrategies(chainKey) {
    const chain = CHAINS[chainKey];
    if (!chain) {
      console.error(`Unknown chain: ${chainKey}`);
      return;
    }

    console.log(`📡 Initializing strategies for ${chain.name}...`);

    // Stop existing strategies
    if (strategies.arbitrage) strategies.arbitrage.stop();
    if (strategies.copytrade) strategies.copytrade.stop();
    if (strategies.sandwich) strategies.sandwich.stop();

    // Arbitrage (all chains)
    if (chain.strategies.includes("arbitrage")) {
      strategies.arbitrage = new ArbitrageStrategy(chainKey, settings, telegramNotify);
      strategies.arbitrage.start(10000); // Check every 10s
      console.log("  ✅ Arbitrage strategy active");
    }

    // Copy-trade (all chains)
    if (chain.strategies.includes("copytrade")) {
      strategies.copytrade = new CopyTradeStrategy(chainKey, settings, telegramNotify);
      strategies.copytrade.start(3000); // Poll every 3s
      console.log("  ✅ Copy-trade strategy active");
    }

    // Sandwich (only chains with mempool)
    if (chain.strategies.includes("sandwich") && chain.hasMempool) {
      strategies.sandwich = new SandwichStrategy(chainKey, settings, telegramNotify);
      strategies.sandwich.start();
      console.log("  ✅ Sandwich strategy active");
    }
  }

  // Start Telegram bot
  const telegram = new TelegramBot(strategies, settings);
  telegramNotify = (msg) => telegram.notify(msg);

  // Update notify reference in strategies
  const updateNotify = () => {
    if (strategies.arbitrage) strategies.arbitrage.notify = telegramNotify;
    if (strategies.copytrade) strategies.copytrade.notify = telegramNotify;
    if (strategies.sandwich) strategies.sandwich.notify = telegramNotify;
  };

  await telegram.start();

  // Initialize strategies for default chain
  initStrategies(settings.activeChain);
  updateNotify();

  // Watch for chain switches
  let currentChain = settings.activeChain;
  setInterval(() => {
    if (settings.activeChain !== currentChain) {
      console.log(`🔄 Switching to ${settings.activeChain}...`);
      initStrategies(settings.activeChain);
      updateNotify();
      currentChain = settings.activeChain;
    }
  }, 1000);

  console.log(`\n✅ MEV Bot running on ${CHAINS[settings.activeChain].name}`);
  console.log(`Strategies: ${CHAINS[settings.activeChain].strategies.join(", ")}`);
  console.log("Waiting for Telegram commands...\n");

  // HTTP healthcheck server (keeps Railway happy)
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const uptime = process.uptime();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        uptime: Math.floor(uptime),
        chain: settings.activeChain,
        paused: settings.paused,
        tokens: strategies.arbitrage?.getTokens()?.length || 0,
        wallets: strategies.copytrade?.getWallets()?.length || 0,
      }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(PORT, () => {
    console.log(`🌐 Healthcheck server on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n🛑 Shutting down...");
    if (strategies.arbitrage) strategies.arbitrage.stop();
    if (strategies.copytrade) strategies.copytrade.stop();
    if (strategies.sandwich) strategies.sandwich.stop();
    telegram.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
