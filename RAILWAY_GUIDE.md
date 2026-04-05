# 🚀 Railway Deployment Guide — MEV Bot

## Step 1: Buat Akun Railway
1. Buka https://railway.app
2. Login pakai GitHub (`nothing010101`)
3. Klik **"New Project"**

## Step 2: Connect GitHub Repo
1. Pilih **"Deploy from GitHub Repo"**
2. Cari dan pilih repo **`nothing010101/mev-bot`** (private)
3. Railway akan otomatis detect project

## Step 3: Set Environment Variables
**⚠️ INI YANG PALING PENTING — jangan sampai salah!**

1. Klik service yang baru dibuat
2. Pergi ke tab **"Variables"**
3. Tambahkan variable berikut **satu per satu**:

| Variable | Value |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | *(private key kamu, tanpa 0x)* |
| `TELEGRAM_BOT_TOKEN` | *(token dari BotFather)* |
| `TELEGRAM_CHAT_ID` | *(chat ID kamu — lihat Step 4)* |
| `BASE_CONTRACT_ADDRESS` | `0x3a4a07993635C8F0Cdea733678f82356cA4b1FCF` |
| `BSC_CONTRACT_ADDRESS` | `0x15D29431D20C25Ad28d1413afFf7bd498998C047` |
| `BASE_RPC_URL` | `https://mainnet.base.org` |
| `BSC_RPC_URL` | `https://bsc-dataseed1.binance.org` |
| `ETH_RPC_URL` | `https://eth.llamarpc.com` |

> **Opsional (untuk sandwich di BSC/ETH — butuh WebSocket):**
> - `BSC_WS_URL` → bisa dari Alchemy, QuickNode, atau NodeReal
> - `ETH_WS_URL` → bisa dari Alchemy atau Infura

## Step 4: Dapatkan Telegram Chat ID
1. Buka Telegram
2. Cari bot **@userinfobot**
3. Kirim `/start`
4. Bot akan reply dengan **ID** kamu (angka, contoh: `123456789`)
5. Masukkan angka itu ke variable `TELEGRAM_CHAT_ID` di Railway

## Step 5: Setting Deployment
1. Klik tab **"Settings"** di service
2. Scroll ke **"Deploy"**
3. Pastikan:
   - **Start Command:** `npm start`
   - **Root Directory:** `/` (kosongkan / default)
   - **Build Command:** biarkan auto (Nixpacks)

## Step 6: Deploy
1. Railway akan auto-deploy setelah kamu set variables
2. Kalau belum, klik **"Deploy"** manual
3. Cek tab **"Logs"** — harus muncul:
   ```
   🚀 Starting MEV Bot...
   📡 Initializing strategies for Base...
     ✅ Arbitrage strategy active
     ✅ Copy-trade strategy active
   🤖 Telegram bot started
   ✅ MEV Bot running on Base
   ```
4. Cek Telegram — bot harus kirim: **"🟢 MEV Bot is online!"**

## Step 7: Test Bot
Buka Telegram, kirim ke bot kamu:
- `/start` — lihat semua command
- `/status` — cek status & balance
- `/chain base` — switch ke Base
- `/chain bsc` — switch ke BSC

## Step 8: Mulai Trading
1. **Deposit ETH ke contract:**
   - `/fund 0.01` — kirim 0.01 ETH dari wallet ke contract
   
2. **Tambah token untuk di-monitor:**
   - `/add 0x...` — masukkan contract address token

3. **Watch wallet (copy-trade):**
   - `/watch 0x... whale1` — monitor wallet tertentu

4. **Setting:**
   - `/setamount 0.005` — trade amount per execution
   - `/setmin 0.001` — minimum profit
   - `/setslippage 3` — max slippage 3%

5. **Withdraw kapan aja:**
   - `/withdraw` — tarik semua dari contract ke wallet

---

## ⚠️ Tips Penting

1. **Jangan expose private key** — Railway variables terenkripsi, aman
2. **Start kecil** — test dengan amount kecil dulu (0.005 ETH)
3. **Monitor logs** — Railway Logs real-time, cek kalau ada error
4. **WebSocket penting untuk sandwich** — tanpa WS, sandwich nggak bisa jalan. Daftar free tier di Alchemy/QuickNode
5. **Railway free tier** ada limit — $5/bulan free credit. Kalau mau 24/7, upgrade ke $5/mo plan

## 🔄 Update Bot
Setiap kali ada update di GitHub:
1. Push code baru ke repo
2. Railway **auto-deploy** otomatis
3. Nggak perlu ngapa-ngapain

## 🛑 Stop Bot
- Di Railway: klik **"Settings"** → **"Remove Service"**
- Atau: pause service di dashboard
- Di Telegram: `/pause` (pause trading tapi bot tetap online)
