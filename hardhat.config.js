require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-verify");

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0".repeat(64);

module.exports = {
  sourcify: {
    enabled: true,
  },
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      accounts: [DEPLOYER_KEY],
      chainId: 8453,
      gasPrice: "auto",
    },
    bsc: {
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org",
      accounts: [DEPLOYER_KEY],
      chainId: 56,
      gasPrice: "auto",
    },
    ethereum: {
      url: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
      accounts: [DEPLOYER_KEY],
      chainId: 1,
      gasPrice: "auto",
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || "",
      bsc: process.env.BSCSCAN_API_KEY || "",
      mainnet: process.env.ETHERSCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
};
