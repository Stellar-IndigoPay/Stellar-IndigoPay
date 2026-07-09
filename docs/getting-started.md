# Getting Started

Welcome! This guide will walk you step-by-step from zero to making your first testnet donation on the platform — no prior blockchain experience required.

---

## 1. Prerequisites

Before you begin, make sure you have the following installed:
| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| npm | Latest |
| Freighter Wallet | Browser extension |

### ✅ Node.js

- Install Node.js (v18 or higher recommended)
- Verify installation:

```
node -v
npm -v
```

### ✅ Freighter Wallet

Freighter is a browser extension wallet for the Stellar network.

- Install Freighter from: https://freighter.app/
- Create a new wallet (or import an existing one)
- Save your secret key securely (very important!)
- 🔁 Switch Freighter to Testnet

## 2. Clone and Run Locally

- 📥 Clone the Repository

```
git clone <your-repo-url>
cd <your-project-folder>
```

- ⚙️ Run Setup Script

```
chmod +x setup-dev.sh
./setup-dev.sh
```

Start Backend

```
cd backend
npm install
npm run dev
```

Start Frontend

```
cd frontend
npm install
npm run dev
```

🌐 Open the App

```
http://localhost:3000
```

## 3. Fund Your Testnet Wallet

- Open Freighter Wallet and and ensure you are using Testnet
- Visit [Stellar Friendbot](https://friendbot.stellar.org) with your public key
- Refresh Freighter — your balance should now show test XLM

## 4. Make Your First Donation

- Find a Project
- Open the app in your browser: http://localhost:3000
- Browse projects and select: “Amazon Reforestation”
- Donate 10 XLM
- Approve in Freighter

## 5. Check Your Impact

### After donating:

- Go to: http://localhost:3000/dashboard
- You should see:
    - A donation badge
    - Your CO₂ offset contribution

## 6. View on the Blockchain

### View Transaction

- After donating
- Click the Stellar Expert link from your donation

## Troubleshooting

### Problem: App says wallet not detected

- Ensure Freighter extension is installed
- Refresh the page
- Make sure it’s enabled in your browser

### Problem: Wallet shows 0 XLM

- Ensure your Freighter wallet is set to in Testnet
- Use Friendbot again:
- https://friendbot.stellar.org/?addr=YOUR_PUBLIC_ADDRESS
- Refresh the wallet

### Problem: Donation fails or is rejected

- Not enough balance → fund wallet again
- Wrong network → switch Freighter to Testnet
- User rejected → retry and approve in Freighter
- Backend not running → ensure backend server is active

### Problem: Page doesn’t load or API fails

- Confirm both frontend and backend are running
- Check terminal logs for errors
- Restart both servers

Start Backend

```
cd backend
npm install
npm run dev
```

Start Frontend

```
cd frontend
npm install
npm run dev
```
