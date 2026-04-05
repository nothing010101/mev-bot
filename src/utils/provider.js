const { ethers } = require("ethers");
const { CHAINS } = require("../config");

const providers = {};
const wallets = {};

function getProvider(chainKey) {
  if (!providers[chainKey]) {
    const chain = CHAINS[chainKey];
    if (!chain) throw new Error(`Unknown chain: ${chainKey}`);
    providers[chainKey] = new ethers.JsonRpcProvider(chain.rpc);
  }
  return providers[chainKey];
}

function getWsProvider(chainKey) {
  const chain = CHAINS[chainKey];
  if (!chain || !chain.ws) return null;
  return new ethers.WebSocketProvider(chain.ws);
}

function getWallet(chainKey) {
  if (!wallets[chainKey]) {
    const pk = process.env.DEPLOYER_PRIVATE_KEY;
    if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
    wallets[chainKey] = new ethers.Wallet(pk, getProvider(chainKey));
  }
  return wallets[chainKey];
}

function getContract(chainKey) {
  const chain = CHAINS[chainKey];
  if (!chain.contract) throw new Error(`No contract deployed on ${chainKey}`);
  
  const abi = require("../../artifacts/contracts/MEVBot.sol/MEVBot.json").abi;
  return new ethers.Contract(chain.contract, abi, getWallet(chainKey));
}

async function getBalance(chainKey) {
  const wallet = getWallet(chainKey);
  const balance = await getProvider(chainKey).getBalance(wallet.address);
  return ethers.formatEther(balance);
}

async function getContractBalance(chainKey) {
  const chain = CHAINS[chainKey];
  if (!chain.contract) return "0";
  const balance = await getProvider(chainKey).getBalance(chain.contract);
  return ethers.formatEther(balance);
}

module.exports = {
  getProvider,
  getWsProvider,
  getWallet,
  getContract,
  getBalance,
  getContractBalance,
};
