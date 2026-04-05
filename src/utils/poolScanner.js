const { ethers } = require("ethers");
const { DEX_CONFIGS, CHAINS } = require("../config");
const { getProvider } = require("./provider");

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
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

// Helper: promise with timeout
function withTimeout(promise, ms, label = "Operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Scan all known DEXes for pools containing the given token
 */
async function scanPoolsForToken(chainKey, tokenAddress) {
  const provider = getProvider(chainKey);
  const chain = CHAINS[chainKey];
  const dexes = DEX_CONFIGS[chainKey] || [];
  const pools = [];
  const errors = [];

  console.log(`[Scanner] Scanning ${dexes.length} DEXes for ${tokenAddress} on ${chainKey}`);

  // Get token info with timeout
  let tokenSymbol = "UNKNOWN";
  let tokenDecimals = 18;
  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [sym, dec] = await withTimeout(
      Promise.all([tokenContract.symbol(), tokenContract.decimals()]),
      10000,
      "Token info"
    );
    tokenSymbol = sym;
    tokenDecimals = Number(dec);
    console.log(`[Scanner] Token: ${tokenSymbol} (${tokenDecimals} decimals)`);
  } catch (e) {
    console.error(`[Scanner] Failed to get token info: ${e.message}`);
    errors.push(`Token info: ${e.message}`);
  }

  // Scan each DEX with timeout
  for (const dex of dexes) {
    try {
      console.log(`[Scanner] Checking ${dex.name}...`);
      const factory = new ethers.Contract(dex.factory, FACTORY_ABI, provider);

      const pairAddress = await withTimeout(
        factory.getPair(tokenAddress, chain.weth),
        10000,
        `${dex.name} getPair`
      );

      if (!pairAddress || pairAddress === ethers.ZeroAddress) {
        console.log(`[Scanner] ${dex.name}: no pair found`);
        continue;
      }

      const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
      const [reserves, token0] = await withTimeout(
        Promise.all([pair.getReserves(), pair.token0()]),
        10000,
        `${dex.name} reserves`
      );

      const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
      const tokenReserve = isToken0 ? reserves[0] : reserves[1];
      const wethReserve = isToken0 ? reserves[1] : reserves[0];
      const liquidityETH = parseFloat(ethers.formatEther(wethReserve));

      console.log(`[Scanner] ${dex.name}: ✅ pair found, ${liquidityETH.toFixed(4)} ETH liquidity`);

      pools.push({
        dex: dex.name,
        router: dex.router,
        factory: dex.factory,
        pair: pairAddress,
        token: tokenAddress,
        tokenSymbol,
        tokenDecimals,
        liquidityETH,
        tokenReserve: tokenReserve.toString(),
        wethReserve: wethReserve.toString(),
        type: dex.type,
      });
    } catch (e) {
      console.error(`[Scanner] ${dex.name}: ❌ ${e.message}`);
      errors.push(`${dex.name}: ${e.message}`);
    }
  }

  console.log(`[Scanner] Done: ${pools.length} pools found, ${errors.length} errors`);

  return { tokenSymbol, tokenDecimals, pools, errors };
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
      const amounts = await withTimeout(
        router.getAmountsOut(amountIn, path),
        10000,
        `${dex.name} quote`
      );

      quotes.push({
        dex: dex.name,
        router: dex.router,
        amountOut: amounts[1].toString(),
        amountOutFormatted: ethers.formatUnits(amounts[1], 18),
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
    const token = new ethers.Contract(
      tokenAddress,
      [
        ...ERC20_ABI,
        "function owner() view returns (address)",
        "function getOwner() view returns (address)",
      ],
      provider
    );

    const totalSupply = await withTimeout(token.totalSupply(), 10000, "totalSupply");

    if (totalSupply === 0n) {
      warnings.push("Total supply is 0");
    }

    try {
      const owner = await withTimeout(token.owner(), 5000, "owner");
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
