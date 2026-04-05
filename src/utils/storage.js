const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "./data";
const STATE_FILE = path.join(DATA_DIR, "state.json");

// Default state
const DEFAULT_STATE = {
  tokens: [],        // [{ address, chain }]
  wallets: [],       // [{ address, label, chain }]
  settings: {
    activeChain: "base",
    tradeAmountETH: "0.01",
    minProfitETH: "0.001",
    maxSlippage: 3,
    maxGasGwei: 50,
    flashloanEnabled: false,
    paused: false,
  },
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState() {
  ensureDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const saved = JSON.parse(raw);
      // Merge with defaults (in case new fields added)
      return {
        ...DEFAULT_STATE,
        ...saved,
        settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
      };
    }
  } catch (e) {
    console.error("Failed to load state:", e.message);
  }
  return { ...DEFAULT_STATE };
}

function saveState(state) {
  ensureDir();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save state:", e.message);
  }
}

// Debounced save — don't write to disk every single change
let saveTimer = null;
function debouncedSave(state) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(state), 1000);
}

module.exports = { loadState, saveState, debouncedSave, DEFAULT_STATE };
