require("dotenv").config();
const http = require("http");

const { DEFAULT_SETTINGS, CHAINS } = require("./config");
const { loadState, saveState, debouncedSave } = require("./utils/storage");
const ArbitrageStrategy = require("./strategies/arbitrage");
const CopyTradeStrategy = require("./strategies/copytrade");
const SandwichStrategy = require("./strategies/sandwich");
const TelegramBot = require("./telegram/bot");

async function main() {
  console.log("🚀 Starting MEV Bot...");

  try {
    console.log(`Node: ${process.version}`);
  } catch(e) { console.error("version check failed:", e.message); }

  try {
    console.log(`ENV check: DEPLOYER_PRIVATE_KEY=${process.env.DEPLOYER_PRIVATE_KEY ? "✅ set" : "❌ missing"}`);
    console.log(`ENV check: TELEGRAM_BOT_TOKEN=${process.env.TELEGRAM_BOT_TOKEN ? "✅ set" : "❌ missing"}`);
    console.log(`ENV check: BASE_CONTRACT_ADDRESS=${process.env.BASE_CONTRACT_ADDRESS || "❌ missing"}`);
    console.log(`ENV check: BSC_CONTRACT_ADDRESS=${process.env.BSC_CONTRACT_ADDRESS || "❌ missing"}`);
  } catch(e) { console.error("env check failed:", e.message); }

  // Load persistent state
  let state;
  try {
    state = loadState();
    console.log(`📂 Loaded state: ${state.tokens.length} tokens, ${state.wallets.length} wallets`);
  } catch(e) {
    console.error("❌ Failed to load state:", e.message);
    state = { tokens: [], wallets: [], settings: {} };
  }

  // Runtime settings (from persistent state)
  const settings = { ...DEFAULT_SETTINGS, ...state.settings };

  // Proxy settings so changes auto-save
  const settingsProxy = new Proxy(settings, {
    set(target, prop, value) {
      target[prop] = value;
      state.settings = { ...target };
      debouncedSave(state);
      return true;
    },
  });

  // Initialize Telegram bot first for notifications
  let telegramNotify = (msg) => console.log(`[NOTIFY] ${msg}`);

  // Initialize strategies per chain
  const strategies = {
    arbitrage: null,
    copytrade: null,
    sandwich: null,
  };

  // Initialize active chain strategies
  async function initStrategies(chainKey) {
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
      strategies.arbitrage = new ArbitrageStrategy(chainKey, settingsProxy, telegramNotify);
      
      // Restore saved tokens for this chain
      const chainTokens = state.tokens.filter((t) => t.chain === chainKey);
      for (const t of chainTokens) {
        try {
          const result = await strategies.arbitrage.addToken(t.address);
          console.log(`  📌 Restored token ${t.address.slice(0, 10)}... → ${result.message}`);
        } catch (e) {
          console.error(`  ⚠️ Failed to restore token ${t.address}: ${e.message}`);
        }
      }

      strategies.arbitrage.start(10000);
      console.log("  ✅ Arbitrage strategy active");
    }

    // Copy-trade (all chains)
    if (chain.strategies.includes("copytrade")) {
      strategies.copytrade = new CopyTradeStrategy(chainKey, settingsProxy, telegramNotify);
      
      // Restore saved wallets for this chain
      const chainWallets = state.wallets.filter((w) => w.chain === chainKey);
      for (const w of chainWallets) {
        strategies.copytrade.addWallet(w.address, w.label);
        console.log(`  📌 Restored wallet ${w.label || w.address.slice(0, 10)}...`);
      }

      strategies.copytrade.start(3000);
      console.log("  ✅ Copy-trade strategy active");
    }

    // Sandwich (only chains with mempool)
    if (chain.strategies.includes("sandwich") && chain.hasMempool) {
      strategies.sandwich = new SandwichStrategy(chainKey, settingsProxy, telegramNotify);
      
      // Restore sandwich targets
      const chainTokens = state.tokens.filter((t) => t.chain === chainKey);
      for (const t of chainTokens) {
        strategies.sandwich.addToken(t.address);
      }
      const chainWallets = state.wallets.filter((w) => w.chain === chainKey);
      for (const w of chainWallets) {
        strategies.sandwich.addTargetWallet(w.address);
      }

      strategies.sandwich.start();
      console.log("  ✅ Sandwich strategy active");
    }
  }

  // Create save helpers for telegram bot to use
  const persistToken = (address, chain) => {
    const existing = state.tokens.find(
      (t) => t.address.toLowerCase() === address.toLowerCase() && t.chain === chain
    );
    if (!existing) {
      state.tokens.push({ address: address.toLowerCase(), chain });
      saveState(state);
    }
  };

  const removePersistedToken = (address, chain) => {
    state.tokens = state.tokens.filter(
      (t) => !(t.address.toLowerCase() === address.toLowerCase() && t.chain === chain)
    );
    saveState(state);
  };

  const persistWallet = (address, label, chain) => {
    const existing = state.wallets.find(
      (w) => w.address.toLowerCase() === address.toLowerCase() && w.chain === chain
    );
    if (!existing) {
      state.wallets.push({ address: address.toLowerCase(), label, chain });
      saveState(state);
    }
  };

  const removePersistedWallet = (address, chain) => {
    state.wallets = state.wallets.filter(
      (w) => !(w.address.toLowerCase() === address.toLowerCase() && w.chain === chain)
    );
    saveState(state);
  };

  // Start Telegram bot with persistence hooks
  let telegram;
  try {
    telegram = new TelegramBot(strategies, settingsProxy, {
      persistToken,
      removePersistedToken,
      persistWallet,
      removePersistedWallet,
    });
    telegramNotify = (msg) => telegram.notify(msg);
    console.log("📱 Telegram bot created");
  } catch(e) {
    console.error("❌ Failed to create Telegram bot:", e.message, e.stack);
    throw e;
  }

  // Update notify reference in strategies
  const updateNotify = () => {
    if (strategies.arbitrage) strategies.arbitrage.notify = telegramNotify;
    if (strategies.copytrade) strategies.copytrade.notify = telegramNotify;
    if (strategies.sandwich) strategies.sandwich.notify = telegramNotify;
  };

  try {
    await telegram.start();
    console.log("📱 Telegram bot started");
  } catch(e) {
    console.error("❌ Telegram bot start failed:", e.message, e.stack);
    throw e;
  }

  // Initialize strategies for default chain
  try {
    await initStrategies(settingsProxy.activeChain);
    updateNotify();
    console.log("✅ Strategies initialized");
  } catch(e) {
    console.error("❌ Strategy init failed:", e.message, e.stack);
  }

  // Watch for chain switches
  let currentChain = settingsProxy.activeChain;
  setInterval(async () => {
    if (settingsProxy.activeChain !== currentChain) {
      console.log(`🔄 Switching to ${settingsProxy.activeChain}...`);
      await initStrategies(settingsProxy.activeChain);
      updateNotify();
      currentChain = settingsProxy.activeChain;
    }
  }, 1000);

  console.log(`\n✅ MEV Bot running on ${CHAINS[settingsProxy.activeChain].name}`);
  console.log(`Strategies: ${CHAINS[settingsProxy.activeChain].strategies.join(", ")}`);
  console.log("Waiting for Telegram commands...\n");

  // HTTP healthcheck server (keeps Railway happy)
  const PORT = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const uptime = process.uptime();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: Math.floor(uptime),
          chain: settingsProxy.activeChain,
          paused: settingsProxy.paused,
          tokens: strategies.arbitrage?.getTokens()?.length || 0,
          wallets: strategies.copytrade?.getWallets()?.length || 0,
        })
      );
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(PORT, () => {
    console.log(`🌐 Healthcheck server on port ${PORT}`);
  });

  // Graceful shutdown — save state before exit
  const shutdown = () => {
    console.log("\n🛑 Shutting down...");
    saveState(state);
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
