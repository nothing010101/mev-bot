const { ethers } = require("ethers");
const { getProvider, getContract } = require("../utils/provider");
const { scanPoolsForToken, getQuotes } = require("../utils/poolScanner");
const { CHAINS } = require("../config");

class ArbitrageStrategy {
  constructor(chainKey, settings, notify) {
    this.chainKey = chainKey;
    this.settings = settings;
    this.notify = notify;
    this.tokens = new Map(); // tokenAddress -> { symbol, pools }
    this.running = false;
    this.interval = null;
  }

  async addToken(tokenAddress) {
    const result = await scanPoolsForToken(this.chainKey, tokenAddress);
    
    // Always track the token (for list/monitoring), even with 0-1 pools
    this.tokens.set(tokenAddress.toLowerCase(), {
      symbol: result.tokenSymbol,
      decimals: result.tokenDecimals,
      pools: result.pools,
      canArbitrage: result.pools.length >= 2,
    });

    if (result.pools.length === 0) {
      return { 
        success: true, 
        tracked: true,
        message: `Added ${result.tokenSymbol} — ⚠️ No pools found on this chain. Token tracked for sandwich/copytrade only.` 
      };
    }

    if (result.pools.length === 1) {
      return { 
        success: true, 
        tracked: true,
        message: `Added ${result.tokenSymbol} — 1 pool found: ${result.pools[0].dex} (${result.pools[0].liquidityETH.toFixed(4)} ETH liq). Need 2+ pools for arbitrage, but tracked for sandwich/copytrade.` 
      };
    }

    return {
      success: true,
      tracked: true,
      message: `Added ${result.tokenSymbol} with ${result.pools.length} pools: ${result.pools.map(p => `${p.dex} (${p.liquidityETH.toFixed(4)} ETH)`).join(", ")}. Arbitrage active! ✅`,
    };
  }

  removeToken(tokenAddress) {
    return this.tokens.delete(tokenAddress.toLowerCase());
  }

  getTokens() {
    const list = [];
    for (const [addr, data] of this.tokens) {
      list.push({
        address: addr,
        symbol: data.symbol,
        poolCount: data.pools.length,
        canArbitrage: data.canArbitrage || false,
        pools: data.pools.map(p => `${p.dex} (${p.liquidityETH.toFixed(4)} ETH liq)`),
      });
    }
    return list;
  }

  async checkArbitrage(tokenAddress) {
    const data = this.tokens.get(tokenAddress.toLowerCase());
    if (!data || data.pools.length < 2) return null;

    const tradeAmount = this.settings.tradeAmountETH || "0.01";
    const quotes = await getQuotes(this.chainKey, tokenAddress, tradeAmount);

    if (quotes.length < 2) return null;

    // Find best buy (highest amountOut) and best sell (we'd need reverse quotes)
    quotes.sort((a, b) => {
      const aOut = BigInt(a.amountOut);
      const bOut = BigInt(b.amountOut);
      return aOut > bOut ? -1 : aOut < bOut ? 1 : 0;
    });

    const bestBuy = quotes[quotes.length - 1]; // Cheapest (least tokens per ETH? No: most tokens = buy here)
    const worstBuy = quotes[0]; // Most expensive

    // Actually: for arb, buy where you get MOST tokens, sell where you get MOST ETH
    // So buy at highest amountOut, then check sell price on other router
    if (quotes.length >= 2) {
      const buyQuote = quotes[0]; // Most tokens per ETH
      const sellQuote = quotes[quotes.length - 1]; // Compare
      
      const diff = BigInt(buyQuote.amountOut) - BigInt(sellQuote.amountOut);
      const diffPercent = Number(diff * 10000n / BigInt(buyQuote.amountOut)) / 100;

      if (diffPercent > 0.5) { // More than 0.5% spread
        return {
          token: tokenAddress,
          symbol: data.symbol,
          buyDex: buyQuote.dex,
          sellDex: sellQuote.dex,
          buyRouter: buyQuote.router,
          sellRouter: sellQuote.router,
          spread: diffPercent,
          tradeAmount,
        };
      }
    }

    return null;
  }

  async executeArbitrage(opportunity) {
    try {
      const contract = getContract(this.chainKey);
      const chain = CHAINS[this.chainKey];
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min

      // Find router names in contract
      const buyRouterName = this._getRouterName(opportunity.buyDex);
      const sellRouterName = this._getRouterName(opportunity.sellDex);

      const amountIn = ethers.parseEther(opportunity.tradeAmount);
      const minProfit = ethers.parseEther(this.settings.minProfitETH || "0.001");

      this.notify(
        `🔄 Executing arbitrage on ${chain.name}\n` +
        `Token: ${opportunity.symbol}\n` +
        `Buy: ${opportunity.buyDex} → Sell: ${opportunity.sellDex}\n` +
        `Amount: ${opportunity.tradeAmount} ${chain.nativeSymbol}\n` +
        `Spread: ${opportunity.spread.toFixed(2)}%`
      );

      const tx = await contract.arbitrage(
        buyRouterName,
        sellRouterName,
        amountIn,
        opportunity.token,
        minProfit,
        deadline,
        { gasLimit: 500000 }
      );

      const receipt = await tx.wait();

      this.notify(
        `✅ Arbitrage executed!\n` +
        `Tx: ${chain.explorer}/tx/${receipt.hash}\n` +
        `Gas used: ${receipt.gasUsed.toString()}`
      );

      return { success: true, tx: receipt.hash };
    } catch (e) {
      this.notify(`❌ Arbitrage failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  _getRouterName(dexName) {
    // Map display name to contract router name
    const map = {
      "Aerodrome": "aerodrome",
      "Uniswap V2": "uniswap_v2",
      "SushiSwap": "sushiswap",
      "PancakeSwap V2": "pancakeswap_v2",
      "BiSwap": "biswap",
    };
    return map[dexName] || dexName.toLowerCase().replace(/\s+/g, "_");
  }

  start(intervalMs = 10000) {
    if (this.running) return;
    this.running = true;

    this.interval = setInterval(async () => {
      if (this.settings.paused) return;

      for (const [tokenAddr] of this.tokens) {
        try {
          const opp = await this.checkArbitrage(tokenAddr);
          if (opp && opp.spread > parseFloat(this.settings.minProfitETH || "0.5")) {
            await this.executeArbitrage(opp);
          }
        } catch (e) {
          console.error(`Arb check error for ${tokenAddr}: ${e.message}`);
        }
      }
    }, intervalMs);
  }

  stop() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = ArbitrageStrategy;
