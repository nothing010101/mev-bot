require("dotenv").config();
const http = require("http");

const { DEFAULT_SETTINGS, CHAINS } = require("./config");
const { loadState, saveState, debouncedSave } = require("./utils/storage");
const ArbitrageStrategy = require("./strategies/arbitrage");
const CopyTradeStrategy = require("./strategies/copytrade");
const SandwichStrategy = require("./strategies/sandwich");
const TelegramBot = require("./telegram/bot");

// ============ START HTTP SERVER FIRST (keeps Railway happy) ============
const PORT = process.env.PORT || 3000;
let botStatus = { status: "starting", uptime: 0, chain: "base", paused: false, tokens: 0, wallets: 0 };

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    botStatus.uptime = Math.floor(process.uptime());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(botStatus));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Healthcheck server on port ${PORT}`);
});

// ============ MAIN BOT LOGIC ============
async function main() {
  console.log("🚀 Starting MEV Bot...");
  console.log(`Node: ${process.version}`);
  console.log(`ENV check: DEPLOYER_PRIVATE_KEY=${process.env.DEPLOYER_PRIVATE_KEY ? "✅ set" : "❌ missing"}`);
  console.log(`ENV check: TELEGRAM_BOT_TOKEN=${process.env.TELEGRAM_BOT_TOKEN ? "✅ set" : "❌ missing"}`);
  console.log(`ENV check: BASE_CONTRACT_ADDRESS=${process.env.BASE_CONTRACT_ADDRESS || "❌ missing"}`);
  console.log(`ENV check: BSC_CONTRACT_ADDRESS=${process.env.BSC_CONTRACT_ADDRESS || "❌ missing"}`);

  // Load persistent state
  let state;
  try {
    state = loadState();
    console.log(`📂 Loaded state: ${state.tokens.length} tokens, ${state.wallets.length} wallets`);
  } catch (e) {
    console.error("❌ Failed to load state:", e.message);
    state = { tokens: [], wallets: [], settings: {} };
  }

  // Runtime settings
  const settings = { ...DEFAULT_SETTINGS, ...state.settings };
  const settingsProxy = new Proxy(settings, {
    set(target, prop, value) {
      target[prop] = value;
      state.settings = { ...target };
      debouncedSave(state);
      return true;
    },
  });

  let telegramNotify = (msg) => console.log(`[NOTIFY] ${msg}`);

  const strategies = {
    arbitrage: null,
    copytrade: null,
    sandwich: null,
  };

  // ============ STRATEGIES ============
  async function initStrategies(chainKey) {
    const chain = CHAINS[chainKey];
    if (!chain) {
      console.error(`Unknown chain: ${chainKey}`);
      return;
    }

    console.log(`📡 Initializing strategies for ${chain.name}...`);

    if (strategies.arbitrage) strategies.arbitrage.stop();
    if (strategies.copytrade) strategies.copytrade.stop();
    if (strategies.sandwich) strategies.sandwich.stop();

    if (chain.strategies.includes("arbitrage")) {
      strategies.arbitrage = new ArbitrageStrategy(chainKey, settingsProxy, telegramNotify);

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

    if (chain.strategies.includes("copytrade")) {
      strategies.copytrade = new CopyTradeStrategy(chainKey, settingsProxy, telegramNotify);

      const chainWallets = state.wallets.filter((w) => w.chain === chainKey);
      for (const w of chainWallets) {
        strategies.copytrade.addWallet(w.address, w.label);
        console.log(`  📌 Restored wallet ${w.label || w.address.slice(0, 10)}...`);
      }

      strategies.copytrade.start(3000);
      console.log("  ✅ Copy-trade strategy active");
    }

    if (chain.strategies.includes("sandwich") && chain.hasMempool) {
      strategies.sandwich = new SandwichStrategy(chainKey, settingsProxy, telegramNotify);

      const chainTokens = state.tokens.filter((t) => t.chain === chainKey);
      for (const t of chainTokens) strategies.sandwich.addToken(t.address);

      const chainWallets = state.wallets.filter((w) => w.chain === chainKey);
      for (const w of chainWallets) strategies.sandwich.addTargetWallet(w.address);

      strategies.sandwich.start();
      console.log("  ✅ Sandwich strategy active");
    }

    // Update bot status for healthcheck
    botStatus.chain = chainKey;
    botStatus.tokens = strategies.arbitrage?.getTokens()?.length || 0;
    botStatus.wallets = strategies.copytrade?.getWallets()?.length || 0;
  }

  // ============ PERSISTENCE HELPERS ============
  const persistToken = (address, chain) => {
    const exists = state.tokens.find(
      (t) => t.address.toLowerCase() === address.toLowerCase() && t.chain === chain
    );
    if (!exists) {
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
    const exists = state.wallets.find(
      (w) => w.address.toLowerCase() === address.toLowerCase() && w.chain === chain
    );
    if (!exists) {
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

  // ============ TELEGRAM ============
  const telegram = new TelegramBot(strategies, settingsProxy, {
    persistToken,
    removePersistedToken,
    persistWallet,
    removePersistedWallet,
  });
  telegramNotify = (msg) => telegram.notify(msg);
  console.log("📱 Telegram bot created");

  const updateNotify = () => {
    if (strategies.arbitrage) strategies.arbitrage.notify = telegramNotify;
    if (strategies.copytrade) strategies.copytrade.notify = telegramNotify;
    if (strategies.sandwich) strategies.sandwich.notify = telegramNotify;
  };

  // Start Telegram with retry (wait for old instance to die)
  await telegram.start();
  console.log("📱 Telegram bot started");

  // ============ INIT STRATEGIES ============
  try {
    await initStrategies(settingsProxy.activeChain);
    updateNotify();
    console.log("✅ Strategies initialized");
  } catch (e) {
    console.error("❌ Strategy init failed:", e.message);
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

  botStatus.status = "running";
  botStatus.paused = settingsProxy.paused;
  console.log(`\n✅ MEV Bot running on ${CHAINS[settingsProxy.activeChain].name}`);
  console.log(`Strategies: ${CHAINS[settingsProxy.activeChain].strategies.join(", ")}`);
  console.log("Waiting for Telegram commands...\n");

  // Graceful shutdown
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
