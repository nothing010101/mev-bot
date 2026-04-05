const { Telegraf, Markup } = require("telegraf");
const { ethers } = require("ethers");
const { CHAINS } = require("../config");
const { getBalance, getContractBalance, getContract, getWallet } = require("../utils/provider");
const { scanPoolsForToken, checkHoneypot } = require("../utils/poolScanner");

class TelegramBot {
  constructor(strategies, settings, persistence = {}) {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.strategies = strategies;
    this.settings = settings;
    this.persistence = persistence; // { persistToken, removePersistedToken, persistWallet, removePersistedWallet }
    this.authorized = new Set();
    
    if (this.chatId) {
      this.authorized.add(this.chatId);
    }

    this._registerCommands();
  }

  _auth(ctx) {
    const chatId = ctx.chat.id.toString();
    if (this.authorized.size === 0) {
      // First user becomes authorized
      this.authorized.add(chatId);
      this.chatId = chatId;
      return true;
    }
    return this.authorized.has(chatId);
  }

  _registerCommands() {
    // Auth middleware
    this.bot.use((ctx, next) => {
      if (!this._auth(ctx)) {
        ctx.reply("⛔ Unauthorized");
        return;
      }
      return next();
    });

    // ============ GENERAL ============
    this.bot.command("start", (ctx) => {
      ctx.reply(
        `🤖 MEV Bot Active\n\n` +
        `Chain: ${CHAINS[this.settings.activeChain]?.name || this.settings.activeChain}\n\n` +
        `Commands:\n` +
        `/status - Bot status & balances\n` +
        `/chain <base|bsc|ethereum> - Switch chain\n\n` +
        `Token Management:\n` +
        `/add <address> - Add token to monitor\n` +
        `/remove <address> - Remove token\n` +
        `/list - List monitored tokens\n` +
        `/pools <address> - Show pools for token\n\n` +
        `Wallet Stalking:\n` +
        `/watch <address> [label] - Watch wallet\n` +
        `/unwatch <address> - Stop watching\n` +
        `/wallets - List watched wallets\n\n` +
        `Trading:\n` +
        `/setamount <ETH> - Trade amount\n` +
        `/setmin <ETH> - Min profit threshold\n` +
        `/setslippage <percent> - Max slippage\n` +
        `/flashloan <on|off> - Toggle flashloan\n\n` +
        `Control:\n` +
        `/pause - Pause trading\n` +
        `/resume - Resume trading\n` +
        `/fund <amount> - Send ETH to contract\n` +
        `/withdraw - Withdraw all from contract\n` +
        `/profits - Profit summary\n` +
        `/history - Recent trades`
      );
    });

    this.bot.command("status", async (ctx) => {
      try {
        const chain = this.settings.activeChain;
        const chainConfig = CHAINS[chain];

        const walletBal = await getBalance(chain);
        let contractBal = "N/A";
        try { contractBal = await getContractBalance(chain); } catch {}

        const arbTokens = this.strategies.arbitrage?.getTokens() || [];
        const watchedWallets = this.strategies.copytrade?.getWallets() || [];

        ctx.reply(
          `📊 Bot Status\n\n` +
          `Chain: ${chainConfig.name}\n` +
          `Paused: ${this.settings.paused ? "⏸ Yes" : "▶️ No"}\n` +
          `Contract: ${chainConfig.contract || "Not deployed"}\n\n` +
          `💰 Balances:\n` +
          `Wallet: ${parseFloat(walletBal).toFixed(6)} ${chainConfig.nativeSymbol}\n` +
          `Contract: ${parseFloat(contractBal).toFixed(6)} ${chainConfig.nativeSymbol}\n\n` +
          `📋 Monitoring:\n` +
          `Tokens: ${arbTokens.length}\n` +
          `Watched wallets: ${watchedWallets.length}\n\n` +
          `⚙️ Settings:\n` +
          `Trade amount: ${this.settings.tradeAmountETH} ${chainConfig.nativeSymbol}\n` +
          `Min profit: ${this.settings.minProfitETH} ${chainConfig.nativeSymbol}\n` +
          `Slippage: ${this.settings.maxSlippage}%\n` +
          `Flash loan: ${this.settings.flashloanEnabled ? "ON" : "OFF"}\n` +
          `Strategies: ${chainConfig.strategies.join(", ")}`
        );
      } catch (e) {
        ctx.reply(`❌ Error: ${e.message}`);
      }
    });

    // ============ CHAIN ============
    this.bot.command("chain", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2) {
        ctx.reply(`Current chain: ${this.settings.activeChain}\nUsage: /chain <base|bsc|ethereum>`);
        return;
      }
      const chain = args[1].toLowerCase();
      if (!CHAINS[chain]) {
        ctx.reply(`❌ Unknown chain: ${chain}\nAvailable: ${Object.keys(CHAINS).join(", ")}`);
        return;
      }
      this.settings.activeChain = chain;
      ctx.reply(`✅ Switched to ${CHAINS[chain].name}`);
    });

    // ============ TOKEN MANAGEMENT ============
    this.bot.command("add", async (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2) {
        ctx.reply("Usage: /add <token_address>");
        return;
      }
      const address = args[1];
      if (!ethers.isAddress(address)) {
        ctx.reply("❌ Invalid address");
        return;
      }

      ctx.reply("🔍 Scanning pools...");

      // Check honeypot
      const hp = await checkHoneypot(this.settings.activeChain, address);
      if (!hp.safe) {
        ctx.reply(`⚠️ Warnings:\n${hp.warnings.join("\n")}\n\nAdding anyway...`);
      }

      // Add to arbitrage strategy
      if (this.strategies.arbitrage) {
        const result = await this.strategies.arbitrage.addToken(address);
        ctx.reply(result.success ? `✅ ${result.message}` : `⚠️ ${result.message}`);
      }

      // Add to sandwich targets
      if (this.strategies.sandwich) {
        this.strategies.sandwich.addToken(address);
      }

      // Persist to disk
      if (this.persistence.persistToken) {
        this.persistence.persistToken(address, this.settings.activeChain);
      }
    });

    this.bot.command("remove", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2) {
        ctx.reply("Usage: /remove <token_address>");
        return;
      }
      const address = args[1];
      
      if (this.strategies.arbitrage) this.strategies.arbitrage.removeToken(address);
      if (this.strategies.sandwich) this.strategies.sandwich.removeToken(address);
      if (this.persistence.removePersistedToken) {
        this.persistence.removePersistedToken(address, this.settings.activeChain);
      }
      
      ctx.reply(`✅ Removed ${address.slice(0, 10)}...`);
    });

    this.bot.command("list", (ctx) => {
      const tokens = this.strategies.arbitrage?.getTokens() || [];
      if (tokens.length === 0) {
        ctx.reply("No tokens being monitored. Use /add <address>");
        return;
      }
      const list = tokens.map((t, i) => {
        const status = t.canArbitrage ? "✅ Arbit active" : "👀 Monitor only";
        const poolInfo = t.pools.length > 0 ? t.pools.join(", ") : "No pools";
        return `${i + 1}. ${t.symbol} ${status}\n   ${t.address}\n   Pools (${t.poolCount}): ${poolInfo}`;
      }).join("\n\n");
      ctx.reply(`📋 Monitored Tokens:\n\n${list}`);
    });

    this.bot.command("pools", async (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2) {
        ctx.reply("Usage: /pools <token_address>");
        return;
      }
      ctx.reply("🔍 Scanning...");
      const result = await scanPoolsForToken(this.settings.activeChain, args[1]);
      if (result.pools.length === 0) {
        ctx.reply(`No pools found for ${result.tokenSymbol}`);
        return;
      }
      const list = result.pools.map((p, i) =>
        `${i + 1}. ${p.dex}\n   Pair: ${p.pair.slice(0, 10)}...\n   Liquidity: ${p.liquidityETH.toFixed(4)} ETH`
      ).join("\n\n");
      ctx.reply(`🏊 Pools for ${result.tokenSymbol}:\n\n${list}`);
    });

    // ============ WALLET STALKING ============
    this.bot.command("watch", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2) {
        ctx.reply("Usage: /watch <wallet_address> [label]");
        return;
      }
      const address = args[1];
      const label = args.slice(2).join(" ") || "";

      if (!ethers.isAddress(address)) {
        ctx.reply("❌ Invalid address");
        return;
      }

      if (this.strategies.copytrade) {
        this.strategies.copytrade.addWallet(address, label);
      }
      if (this.strategies.sandwich) {
        this.strategies.sandwich.addTargetWallet(address);
      }
      if (this.persistence.persistWallet) {
        this.persistence.persistWallet(address, label, this.settings.activeChain);
      }

      ctx.reply(`✅ Watching ${label || address.slice(0, 10)}...`);
    });

    this.bot.command("unwatch", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2) {
        ctx.reply("Usage: /unwatch <wallet_address>");
        return;
      }

      if (this.strategies.copytrade) this.strategies.copytrade.removeWallet(args[1]);
      if (this.strategies.sandwich) this.strategies.sandwich.removeTargetWallet(args[1]);
      if (this.persistence.removePersistedWallet) {
        this.persistence.removePersistedWallet(args[1], this.settings.activeChain);
      }

      ctx.reply(`✅ Stopped watching ${args[1].slice(0, 10)}...`);
    });

    this.bot.command("wallets", (ctx) => {
      const wallets = this.strategies.copytrade?.getWallets() || [];
      if (wallets.length === 0) {
        ctx.reply("No wallets being watched. Use /watch <address>");
        return;
      }
      const list = wallets.map((w, i) =>
        `${i + 1}. ${w.label}\n   ${w.address}`
      ).join("\n\n");
      ctx.reply(`👀 Watched Wallets:\n\n${list}`);
    });

    // ============ SETTINGS ============
    this.bot.command("setamount", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2 || isNaN(args[1])) {
        ctx.reply(`Current: ${this.settings.tradeAmountETH}\nUsage: /setamount <ETH>`);
        return;
      }
      this.settings.tradeAmountETH = args[1];
      ctx.reply(`✅ Trade amount: ${args[1]} ETH`);
    });

    this.bot.command("setmin", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2 || isNaN(args[1])) {
        ctx.reply(`Current: ${this.settings.minProfitETH}\nUsage: /setmin <ETH>`);
        return;
      }
      this.settings.minProfitETH = args[1];
      ctx.reply(`✅ Min profit: ${args[1]} ETH`);
    });

    this.bot.command("setslippage", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2 || isNaN(args[1])) {
        ctx.reply(`Current: ${this.settings.maxSlippage}%\nUsage: /setslippage <percent>`);
        return;
      }
      this.settings.maxSlippage = parseFloat(args[1]);
      ctx.reply(`✅ Max slippage: ${args[1]}%`);
    });

    this.bot.command("flashloan", (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2) {
        ctx.reply(`Flash loan: ${this.settings.flashloanEnabled ? "ON" : "OFF"}\nUsage: /flashloan <on|off>`);
        return;
      }
      this.settings.flashloanEnabled = args[1].toLowerCase() === "on";
      ctx.reply(`✅ Flash loan: ${this.settings.flashloanEnabled ? "ON" : "OFF"}`);
    });

    // ============ CONTROL ============
    this.bot.command("pause", (ctx) => {
      this.settings.paused = true;
      ctx.reply("⏸ Bot paused. Trading stopped, monitoring continues.");
    });

    this.bot.command("resume", (ctx) => {
      this.settings.paused = false;
      ctx.reply("▶️ Bot resumed. Trading active.");
    });

    this.bot.command("fund", async (ctx) => {
      const args = ctx.message.text.split(" ");
      if (args.length < 2 || isNaN(args[1])) {
        ctx.reply("Usage: /fund <ETH_amount>");
        return;
      }

      const chain = this.settings.activeChain;
      const chainConfig = CHAINS[chain];
      if (!chainConfig.contract) {
        ctx.reply("❌ No contract deployed on this chain");
        return;
      }

      try {
        const wallet = getWallet(chain);
        const amount = ethers.parseEther(args[1]);

        ctx.reply(`📤 Sending ${args[1]} ${chainConfig.nativeSymbol} to contract...`);

        const tx = await wallet.sendTransaction({
          to: chainConfig.contract,
          value: amount,
        });

        const receipt = await tx.wait();
        ctx.reply(
          `✅ Funded!\n` +
          `Amount: ${args[1]} ${chainConfig.nativeSymbol}\n` +
          `Tx: ${chainConfig.explorer}/tx/${receipt.hash}`
        );
      } catch (e) {
        ctx.reply(`❌ Fund failed: ${e.message}`);
      }
    });

    this.bot.command("withdraw", async (ctx) => {
      const chain = this.settings.activeChain;
      const chainConfig = CHAINS[chain];

      try {
        const contract = getContract(chain);
        ctx.reply("📥 Withdrawing all from contract...");

        const tx = await contract.withdrawAll({ gasLimit: 500000 });
        const receipt = await tx.wait();

        ctx.reply(
          `✅ Withdrawn!\n` +
          `Tx: ${chainConfig.explorer}/tx/${receipt.hash}`
        );
      } catch (e) {
        ctx.reply(`❌ Withdraw failed: ${e.message}`);
      }
    });

    this.bot.command("profits", (ctx) => {
      // TODO: Implement profit tracking from events
      ctx.reply("📊 Profit tracking coming soon. Check contract balance with /status");
    });

    this.bot.command("history", (ctx) => {
      // TODO: Implement trade history from events
      ctx.reply("📜 Trade history coming soon. Check explorer for now.");
    });

    // ============ HEALTH ============
    this.bot.command("ping", (ctx) => {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const secs = Math.floor(uptime % 60);
      const mem = process.memoryUsage();
      
      ctx.reply(
        `🏓 Pong!\n\n` +
        `⏱ Uptime: ${hours}h ${mins}m ${secs}s\n` +
        `💾 Memory: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB\n` +
        `🔗 Chain: ${CHAINS[this.settings.activeChain]?.name}\n` +
        `⏸ Paused: ${this.settings.paused ? "Yes" : "No"}\n` +
        `📋 Tokens: ${this.strategies.arbitrage?.getTokens()?.length || 0}\n` +
        `👀 Wallets: ${this.strategies.copytrade?.getWallets()?.length || 0}`
      );
    });
  }

  async notify(message) {
    if (this.chatId) {
      try {
        await this.bot.telegram.sendMessage(this.chatId, message);
      } catch (e) {
        console.error(`Telegram notify error: ${e.message}`);
      }
    }
  }

  async start() {
    // Set menu commands (hamburger button)
    await this.bot.telegram.setMyCommands([
      { command: "start", description: "📋 Show all commands" },
      { command: "status", description: "📊 Bot status & balances" },
      { command: "chain", description: "🔗 Switch chain (base/bsc/ethereum)" },
      { command: "add", description: "➕ Add token to monitor" },
      { command: "remove", description: "➖ Remove token" },
      { command: "list", description: "📋 List monitored tokens" },
      { command: "pools", description: "🏊 Show pools for token" },
      { command: "watch", description: "👀 Watch wallet address" },
      { command: "unwatch", description: "🚫 Stop watching wallet" },
      { command: "wallets", description: "👥 List watched wallets" },
      { command: "setamount", description: "💰 Set trade amount" },
      { command: "setmin", description: "📉 Set min profit threshold" },
      { command: "setslippage", description: "📐 Set max slippage %" },
      { command: "flashloan", description: "⚡ Toggle flash loan on/off" },
      { command: "fund", description: "📤 Send ETH/BNB to contract" },
      { command: "withdraw", description: "📥 Withdraw all from contract" },
      { command: "pause", description: "⏸ Pause trading" },
      { command: "resume", description: "▶️ Resume trading" },
      { command: "profits", description: "💵 Profit summary" },
      { command: "history", description: "📜 Recent trades" },
      { command: "ping", description: "🏓 Check if bot is alive" },
    ]);

    await this.bot.launch();
    console.log("🤖 Telegram bot started (menu commands registered)");

    if (this.chatId) {
      await this.notify("🟢 MEV Bot is online!");
    }
  }

  stop() {
    this.bot.stop();
  }
}

module.exports = TelegramBot;
