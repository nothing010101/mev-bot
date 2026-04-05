const { ethers } = require("ethers");
const { getProvider, getContract } = require("../utils/provider");
const { CHAINS } = require("../config");

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256,address[],address,uint256)",
  "function swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
];

// Method signatures for swap detection
const SWAP_SIGNATURES = {
  "0x7ff36ab5": "swapExactETHForTokens",
  "0x18cbafe5": "swapExactTokensForETH",
  "0x38ed1739": "swapExactTokensForTokens",
  "0xfb3bdb41": "swapETHForExactTokens",
  "0xb6f9de95": "swapExactETHForTokensSupportingFeeOnTransferTokens",
  "0x791ac947": "swapExactTokensForETHSupportingFeeOnTransferTokens",
};

class CopyTradeStrategy {
  constructor(chainKey, settings, notify) {
    this.chainKey = chainKey;
    this.settings = settings;
    this.notify = notify;
    this.watchedWallets = new Map(); // address -> { label }
    this.running = false;
    this.pollInterval = null;
    this.lastBlock = 0;
  }

  addWallet(address, label = "") {
    this.watchedWallets.set(address.toLowerCase(), { label: label || address.slice(0, 10) });
    return true;
  }

  removeWallet(address) {
    return this.watchedWallets.delete(address.toLowerCase());
  }

  getWallets() {
    const list = [];
    for (const [addr, data] of this.watchedWallets) {
      list.push({ address: addr, label: data.label });
    }
    return list;
  }

  async start(intervalMs = 3000) {
    if (this.running) return;
    this.running = true;

    const provider = getProvider(this.chainKey);
    this.lastBlock = await provider.getBlockNumber();

    this.pollInterval = setInterval(async () => {
      if (this.settings.paused || this.watchedWallets.size === 0) return;

      try {
        await this._scanNewBlocks();
      } catch (e) {
        console.error(`CopyTrade scan error: ${e.message}`);
      }
    }, intervalMs);
  }

  stop() {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async _scanNewBlocks() {
    const provider = getProvider(this.chainKey);
    const currentBlock = await provider.getBlockNumber();

    if (currentBlock <= this.lastBlock) return;

    for (let blockNum = this.lastBlock + 1; blockNum <= currentBlock; blockNum++) {
      try {
        const block = await provider.getBlock(blockNum, true);
        if (!block || !block.transactions) continue;

        for (const txHash of block.transactions) {
          try {
            const tx = await provider.getTransaction(txHash);
            if (!tx || !tx.from) continue;

            const fromLower = tx.from.toLowerCase();
            if (this.watchedWallets.has(fromLower)) {
              await this._handleWatchedTx(tx, this.watchedWallets.get(fromLower));
            }
          } catch {}
        }
      } catch (e) {
        console.error(`Block ${blockNum} scan error: ${e.message}`);
      }
    }

    this.lastBlock = currentBlock;
  }

  async _handleWatchedTx(tx, walletData) {
    if (!tx.data || tx.data.length < 10) return;

    const methodId = tx.data.slice(0, 10);
    const swapMethod = SWAP_SIGNATURES[methodId];

    if (!swapMethod) return; // Not a swap

    const chain = CHAINS[this.chainKey];

    this.notify(
      `👀 Wallet ${walletData.label} swapped!\n` +
      `Method: ${swapMethod}\n` +
      `Value: ${ethers.formatEther(tx.value || 0)} ${chain.nativeSymbol}\n` +
      `Tx: ${chain.explorer}/tx/${tx.hash}\n` +
      `Attempting copy-trade...`
    );

    // Decode and copy the trade
    try {
      await this._copyTrade(tx, swapMethod);
    } catch (e) {
      this.notify(`❌ Copy-trade failed: ${e.message}`);
    }
  }

  async _copyTrade(tx, swapMethod) {
    const chain = CHAINS[this.chainKey];
    const contract = getContract(this.chainKey);
    const iface = new ethers.Interface(ROUTER_ABI);

    // Determine trade amount based on settings
    const tradeAmount = ethers.parseEther(this.settings.tradeAmountETH || "0.01");
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const slippage = this.settings.maxSlippage || 3;

    if (swapMethod.includes("ETHForTokens")) {
      // Target bought tokens with ETH — we do the same
      try {
        const decoded = iface.decodeFunctionData(swapMethod, tx.data);
        const path = decoded[1] || decoded.path;

        if (!path || path.length < 2) return;

        const token = path[path.length - 1];

        // Find which router name to use
        const routerName = this._findRouterByAddress(tx.to);
        if (!routerName) {
          this.notify(`⚠️ Unknown router: ${tx.to}`);
          return;
        }

        const txResult = await contract.sandwichBuy(
          routerName,
          tradeAmount,
          0, // amountOutMin (we accept slippage for speed)
          path,
          deadline,
          { gasLimit: 500000 }
        );

        const receipt = await txResult.wait();
        this.notify(
          `✅ Copy-trade executed!\n` +
          `Bought token: ${token}\n` +
          `Amount: ${ethers.formatEther(tradeAmount)} ${chain.nativeSymbol}\n` +
          `Tx: ${chain.explorer}/tx/${receipt.hash}`
        );
      } catch (e) {
        throw e;
      }
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

module.exports = CopyTradeStrategy;
