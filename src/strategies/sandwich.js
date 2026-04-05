const { ethers } = require("ethers");
const { getProvider, getWsProvider, getContract } = require("../utils/provider");
const { CHAINS } = require("../config");

// Swap method signatures to detect
const SWAP_SIGS = {
  "0x7ff36ab5": { name: "swapExactETHForTokens", hasValue: true },
  "0xfb3bdb41": { name: "swapETHForExactTokens", hasValue: true },
  "0xb6f9de95": { name: "swapExactETHForTokensSupportingFeeOnTransferTokens", hasValue: true },
};

class SandwichStrategy {
  constructor(chainKey, settings, notify) {
    this.chainKey = chainKey;
    this.settings = settings;
    this.notify = notify;
    this.targetTokens = new Set(); // tokens to sandwich
    this.targetWallets = new Set(); // specific wallets to target
    this.running = false;
    this.wsProvider = null;
  }

  addToken(address) {
    this.targetTokens.add(address.toLowerCase());
  }

  removeToken(address) {
    this.targetTokens.delete(address.toLowerCase());
  }

  addTargetWallet(address) {
    this.targetWallets.add(address.toLowerCase());
  }

  removeTargetWallet(address) {
    this.targetWallets.delete(address.toLowerCase());
  }

  async start() {
    const chain = CHAINS[this.chainKey];
    if (!chain.hasMempool) {
      this.notify(`⚠️ ${chain.name} doesn't have a public mempool. Sandwich not available on this chain.`);
      return false;
    }

    if (!chain.ws) {
      this.notify(`⚠️ WebSocket URL not configured for ${chain.name}. Set ${this.chainKey.toUpperCase()}_WS_URL in .env`);
      return false;
    }

    this.running = true;

    try {
      this.wsProvider = getWsProvider(this.chainKey);
      if (!this.wsProvider) {
        this.notify(`⚠️ Cannot create WebSocket connection for ${chain.name}`);
        return false;
      }

      // Subscribe to pending transactions
      this.wsProvider.on("pending", async (txHash) => {
        if (!this.running || this.settings.paused) return;

        try {
          const tx = await this.wsProvider.getTransaction(txHash);
          if (!tx) return;

          await this._analyzePendingTx(tx);
        } catch {}
      });

      this.notify(`🥪 Sandwich bot started on ${chain.name} (monitoring mempool)`);
      return true;
    } catch (e) {
      this.notify(`❌ Failed to start sandwich on ${chain.name}: ${e.message}`);
      return false;
    }
  }

  stop() {
    this.running = false;
    if (this.wsProvider) {
      this.wsProvider.removeAllListeners();
      this.wsProvider.destroy();
      this.wsProvider = null;
    }
  }

  async _analyzePendingTx(tx) {
    if (!tx.data || tx.data.length < 10) return;
    if (!tx.to) return;

    const methodId = tx.data.slice(0, 10);
    const swapInfo = SWAP_SIGS[methodId];
    if (!swapInfo) return; // Not a swap we care about

    // Check if from a targeted wallet (if any wallets are set)
    if (this.targetWallets.size > 0 && !this.targetWallets.has(tx.from.toLowerCase())) {
      return;
    }

    // Decode to get token path
    try {
      const iface = new ethers.Interface([
        "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
        "function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)",
        "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
      ]);

      const decoded = iface.decodeFunctionData(swapInfo.name, tx.data);
      const path = decoded[1] || decoded.path;
      if (!path || path.length < 2) return;

      const targetToken = path[path.length - 1].toLowerCase();

      // Check if token is in our target list (or if we're targeting specific wallets, any token is fine)
      if (this.targetTokens.size > 0 && !this.targetTokens.has(targetToken)) {
        return;
      }

      const victimValue = parseFloat(ethers.formatEther(tx.value || 0));
      const minVictimValue = parseFloat(this.settings.minVictimValue || "0.05");

      if (victimValue < minVictimValue) return; // Too small

      await this._executeSandwich(tx, path, targetToken, victimValue);
    } catch {}
  }

  async _executeSandwich(victimTx, path, targetToken, victimValue) {
    const chain = CHAINS[this.chainKey];
    const contract = getContract(this.chainKey);
    const tradeAmount = ethers.parseEther(this.settings.tradeAmountETH || "0.05");
    const deadline = Math.floor(Date.now() / 1000) + 120;

    this.notify(
      `🥪 Sandwich opportunity!\n` +
      `Victim: ${victimTx.from.slice(0, 10)}...\n` +
      `Token: ${targetToken.slice(0, 10)}...\n` +
      `Value: ${victimValue.toFixed(4)} ${chain.nativeSymbol}\n` +
      `Executing frontrun...`
    );

    try {
      // Find router name
      const routerName = this._findRouterByAddress(victimTx.to);
      if (!routerName) return;

      // STEP 1: Frontrun — buy before victim
      const victimGasPrice = victimTx.gasPrice || victimTx.maxFeePerGas;
      const frontrunGasPrice = victimGasPrice * 110n / 100n; // 10% higher gas

      const buyTx = await contract.sandwichBuy(
        routerName,
        tradeAmount,
        0,
        path,
        deadline,
        {
          gasPrice: frontrunGasPrice,
          gasLimit: 500000,
        }
      );

      const buyReceipt = await buyTx.wait();

      this.notify(
        `✅ Frontrun success!\n` +
        `Tx: ${chain.explorer}/tx/${buyReceipt.hash}\n` +
        `Waiting for victim tx to confirm...`
      );

      // STEP 2: Wait for victim tx to confirm
      try {
        const victimReceipt = await victimTx.wait(1, 60000); // 60s timeout
        
        if (!victimReceipt || victimReceipt.status === 0) {
          this.notify(`⚠️ Victim tx failed. Selling tokens back...`);
        }
      } catch {
        this.notify(`⚠️ Victim tx timeout. Selling tokens back anyway...`);
      }

      // STEP 3: Backrun — sell all tokens
      const sellTx = await contract.sandwichSell(
        routerName,
        targetToken,
        0,
        deadline + 300,
        { gasLimit: 500000 }
      );

      const sellReceipt = await sellTx.wait();

      this.notify(
        `✅ Sandwich complete!\n` +
        `Sell tx: ${chain.explorer}/tx/${sellReceipt.hash}\n` +
        `Gas: buy=${buyReceipt.gasUsed} sell=${sellReceipt.gasUsed}`
      );
    } catch (e) {
      this.notify(`❌ Sandwich failed: ${e.message}`);
    }
  }

  _findRouterByAddress(routerAddress) {
    const { DEX_CONFIGS } = require("../config");
    const dexes = DEX_CONFIGS[this.chainKey] || [];
    
    for (const dex of dexes) {
      if (dex.router.toLowerCase() === routerAddress.toLowerCase()) {
        return dex.name.toLowerCase().replace(/\s+/g, "_");
      }
    }
    return null;
  }
}

module.exports = SandwichStrategy;
