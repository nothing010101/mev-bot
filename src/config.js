require("dotenv").config();

const CHAINS = {
  base: {
    id: 8453,
    name: "Base",
    rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    ws: process.env.BASE_WS_URL || null,
    weth: "0x4200000000000000000000000000000000000006",
    explorer: "https://basescan.org",
    contract: process.env.BASE_CONTRACT_ADDRESS || "",
    nativeSymbol: "ETH",
    hasMempool: false, // L2 sequencer, no public mempool
    strategies: ["arbitrage", "copytrade"],
  },
  bsc: {
    id: 56,
    name: "BSC",
    rpc: process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org",
    ws: process.env.BSC_WS_URL || null,
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    explorer: "https://bscscan.com",
    contract: process.env.BSC_CONTRACT_ADDRESS || "",
    nativeSymbol: "BNB",
    hasMempool: true,
    strategies: ["sandwich", "arbitrage", "copytrade"],
  },
  ethereum: {
    id: 1,
    name: "Ethereum",
    rpc: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
    ws: process.env.ETH_WS_URL || null,
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    explorer: "https://etherscan.io",
    contract: process.env.ETH_CONTRACT_ADDRESS || "",
    nativeSymbol: "ETH",
    hasMempool: true,
    strategies: ["sandwich", "arbitrage", "copytrade"],
  },
};

// DEX routers per chain for pool discovery
const DEX_CONFIGS = {
  base: [
    {
      name: "Aerodrome",
      factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
      router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
      type: "v2",
      initCodeHash: "0x",
    },
    {
      name: "Uniswap V2",
      factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
      router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      type: "v2",
    },
    {
      name: "SushiSwap",
      factory: "0x71524B4f93c58fcbF659783284E38825f0622859",
      router: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
      type: "v2",
    },
  ],
  bsc: [
    {
      name: "PancakeSwap V2",
      factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
      router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      type: "v2",
    },
    {
      name: "BiSwap",
      factory: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE",
      router: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8",
      type: "v2",
    },
  ],
};

const DEFAULT_SETTINGS = {
  minProfitETH: "0.001",
  maxSlippage: 3, // percent
  maxGasGwei: 50,
  tradeAmountETH: "0.01",
  flashloanEnabled: false,
  activeChain: "base",
  paused: false,
};

module.exports = { CHAINS, DEX_CONFIGS, DEFAULT_SETTINGS };
