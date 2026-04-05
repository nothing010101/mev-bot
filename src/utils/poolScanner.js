const { ethers } = require("ethers");
const { DEX_CONFIGS, CHAINS } = require("../config");
const { getProvider } = require("./provider");

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
  "function allPairsLength() view returns (uint256)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
];

/**
 * Scan all known DEXes for pools containing the given token
 */
async function scanPoolsForToken(chainKey, tokenAddress) {
  const provider = getProvider(chainKey);
  const chain = CHAINS[chainKey];
  const dexes = DEX_CONFIGS[chainKey] || [];
  const pools = [];

  // Get token info
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  let tokenSymbol, tokenDecimals;
  try {
    [tokenSymbol, tokenDecimals] = await Promise.all([
      tokenContract.symbol(),
      tokenContract.decimals(),
    ]);
  } catch (e) {
    tokenSymbol = "UNKNOWN";
    tokenDecimals = 18;
  }

  for (const dex of dexes) {
    try {
      const factory = new ethers.Contract(dex.factory, FACTORY_ABI, provider);
      
      // Check pair with WETH/WBNB
      const pairAddress = await factory.getPair(tokenAddress, chain.weth);
      
      if (pairAddress && pairAddress !== ethers.ZeroAddress) {
        const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        const [reserves, token0] = await Promise.all([
          pair.getReserves(),
          pair.token0(),
        ]);

        const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
        const tokenReserve = isToken0 ? reserves[0] : reserves[1];
        const wethReserve = isToken0 ? reserves[1] : reserves[0];

        const liquidityETH = parseFloat(ethers.formatEther(wethReserve));

        pools.push({
          dex: dex.name,
          router: dex.router,
          factory: dex.factory,
          pair: pairAddress,
          token: tokenAddress,
          tokenSymbol,
          tokenDecimals: Number(tokenDecimals),
          liquidityETH,
          tokenReserve: tokenReserve.toString(),
          wethReserve: wethReserve.toString(),
          type: dex.type,
        });
      }
    } catch (e) {
      // Skip failed DEX
      console.error(`Error scanning ${dex.name}: ${e.message}`);
    }
  }

  return { tokenSymbol, tokenDecimals: Number(tokenDecimals), pools };
}

/**
 * Get price quotes across routers for arbitrage detection
 */
async function getQuotes(chainKey, tokenAddress, amountInETH) {
  const provider = getProvider(chainKey);
  const chain = CHAINS[chainKey];
  const dexes = DEX_CONFIGS[chainKey] || [];
  const amountIn = ethers.parseEther(amountInETH);
  const quotes = [];

  for (const dex of dexes) {
    try {
      const router = new ethers.Contract(dex.router, ROUTER_ABI, provider);
      const path = [chain.weth, tokenAddress];
      const amounts = await router.getAmountsOut(amountIn, path);
      
      quotes.push({
        dex: dex.name,
        router: dex.router,
        amountOut: amounts[1].toString(),
        amountOutFormatted: ethers.formatUnits(amounts[1], 18), // adjust decimals as needed
      });
    } catch (e) {
      // Skip if no liquidity or error
    }
  }

  return quotes;
}

/**
 * Simple honeypot detection
 */
async function checkHoneypot(chainKey, tokenAddress) {
  const provider = getProvider(chainKey);
  const warnings = [];

  try {
    const token = new ethers.Contract(tokenAddress, [
      ...ERC20_ABI,
      "function owner() view returns (address)",
      "function getOwner() view returns (address)",
    ], provider);

    const totalSupply = await token.totalSupply();
    
    // Check if total supply is suspiciously low
    if (totalSupply === 0n) {
      warnings.push("Total supply is 0");
    }

    // Try to check if token has owner functions (centralization risk)
    try {
      const owner = await token.owner();
      if (owner !== ethers.ZeroAddress) {
        warnings.push(`Token has owner: ${owner}`);
      }
    } catch {}

  } catch (e) {
    warnings.push(`Cannot read token contract: ${e.message}`);
  }

  return {
    safe: warnings.length === 0,
    warnings,
  };
}

module.exports = { scanPoolsForToken, getQuotes, checkHoneypot };
