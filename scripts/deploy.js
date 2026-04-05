const hre = require("hardhat");

// WETH addresses per chain
const WETH_ADDRESSES = {
  8453: "0x4200000000000000000000000000000000000006", // Base
  56: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // BSC (WBNB)
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // ETH Mainnet
};

// Default routers per chain
const DEFAULT_ROUTERS = {
  8453: [
    {
      name: "aerodrome",
      router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
      factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
      isV3: false,
    },
    {
      name: "uniswap_v2",
      router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
      isV3: false,
    },
    {
      name: "sushiswap",
      router: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
      factory: "0x71524B4f93c58fcbF659783284E38825f0622859",
      isV3: false,
    },
  ],
  56: [
    {
      name: "pancakeswap_v2",
      router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
      isV3: false,
    },
    {
      name: "biswap",
      router: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8",
      factory: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE",
      isV3: false,
    },
  ],
};

async function main() {
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const chainIdNum = Number(chainId);
  
  console.log(`\nDeploying MEVBot to chain ${chainIdNum}...`);
  
  const weth = WETH_ADDRESSES[chainIdNum];
  if (!weth) {
    throw new Error(`No WETH address configured for chain ${chainIdNum}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${hre.ethers.formatEther(balance)} ETH`);

  // Deploy contract
  const MEVBot = await hre.ethers.getContractFactory("MEVBot");
  const bot = await MEVBot.deploy(weth);
  await bot.waitForDeployment();
  
  const contractAddress = await bot.getAddress();
  console.log(`\n✅ MEVBot deployed to: ${contractAddress}`);

  // Add default routers
  const chainRouters = DEFAULT_ROUTERS[chainIdNum] || [];
  for (const r of chainRouters) {
    console.log(`Adding router: ${r.name}...`);
    const tx = await bot.addRouter(r.name, r.router, r.factory, r.isV3);
    await tx.wait();
    console.log(`  ✅ ${r.name} added`);
  }

  console.log(`\n🎉 Deployment complete!`);
  console.log(`Contract: ${contractAddress}`);
  console.log(`Chain: ${chainIdNum}`);
  console.log(`Routers: ${chainRouters.length} added`);
  
  // Save deployment info
  const fs = require("fs");
  const deployments = JSON.parse(
    fs.existsSync("./deployments.json") ? fs.readFileSync("./deployments.json") : "{}"
  );
  deployments[chainIdNum] = {
    contract: contractAddress,
    deployer: deployer.address,
    weth: weth,
    routers: chainRouters.map(r => r.name),
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync("./deployments.json", JSON.stringify(deployments, null, 2));
  
  console.log(`\nDeployment info saved to deployments.json`);
  console.log(`\nTo verify: npx hardhat verify --network ${hre.network.name} ${contractAddress} "${weth}"`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
