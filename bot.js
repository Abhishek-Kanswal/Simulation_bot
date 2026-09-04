const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Telegram Bot
const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("Error: TELEGRAM_BOT_TOKEN missing in .env file.");
  process.exit(1);
}
const bot = new TelegramBot(botToken, { polling: true });

// Global In-Memory Portfolio Database
let portfolio = [];

// ==========================================
// 1. HELPER FUNCTIONS
// ==========================================

// Extract Contract Address (CA) from channel text or inline buttons (DexScreener links)
function extractCAFromMessage(msg) {
  let contentPool = [];

  if (msg.text) contentPool.push(msg.text);
  if (msg.caption) contentPool.push(msg.caption);

  // Parse inline keyboard button URLs (e.g., DexS, GMGN buttons)
  if (msg.reply_markup && msg.reply_markup.inline_keyboard) {
    for (const row of msg.reply_markup.inline_keyboard) {
      for (const btn of row) {
        if (btn.url) contentPool.push(btn.url);
      }
    }
  }

  const combinedText = contentPool.join(" ");

  // Matches standard EVM 42-character address (0x...)
  const caRegex = /0x[a-fA-F0-9]{40}/;
  const match = combinedText.match(caRegex);

  return match ? match[0] : null;
}

// Fetch live price & metadata directly from DexScreener API
async function getTokenDataFromDexScreener(tokenAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const response = await axios.get(url);

    if (
      response.data &&
      response.data.pairs &&
      response.data.pairs.length > 0
    ) {
      // Pick the highest liquidity pool for accuracy
      const pair = response.data.pairs[0];
      return {
        price: parseFloat(pair.priceUsd),
        symbol: pair.baseToken.symbol || "UNKNOWN",
        name: pair.baseToken.name || "Unknown Token",
        chain: pair.chainId,
        pairUrl: pair.url,
      };
    }
    return null;
  } catch (error) {
    console.error(`[DexScreener Error] Could not fetch data for ${tokenAddress}:`, error.message);
    return null;
  }
}

// Format portfolio response for Telegram
function formatPortfolioMessage() {
  if (portfolio.length === 0) {
    return "📊 *Portfolio is empty.*\nNo channel calls simulated yet.";
  }

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let activeText = "";
  let closedText = "";

  portfolio.forEach((pos, index) => {
    totalInvested += pos.invested;

    if (pos.status === "HOLDING") {
      totalCurrentValue += pos.currentValue;
      const gainX = (pos.currentPrice / pos.entryPrice).toFixed(2);
      const pnlPercent = (((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(1);
      const pnlSign = pnlPercent >= 0 ? "+" : "";

      activeText += `\n${index + 1}. *$${pos.symbol}* (${pos.chain})
  • Entry: $${pos.entryPrice} | Cur: $${pos.currentPrice}
  • Value: *$${pos.currentValue.toFixed(2)}* (${gainX}x / ${pnlSign}${pnlPercent}%)`;
    } else {
      totalCurrentValue += pos.exitValue;
      const finalX = (pos.exitPrice / pos.entryPrice).toFixed(2);
      const isProfit = pos.status.includes("PROFIT");
      const icon = isProfit ? "🟢" : "🔴";

      closedText += `\n${icon} *$${pos.symbol}* — ${pos.status}
  • Entry: $${pos.entryPrice} ➔ Exit: $${pos.exitPrice}
  • Result: *${finalX}x* | Final Val: *$${pos.exitValue.toFixed(2)}*`;
    }
  });

  const overallPnL = totalCurrentValue - totalInvested;
  const overallPnLSign = overallPnL >= 0 ? "+" : "";

  return `📊 *SIMULATED PORTFOLIO MATRIX*
━━━━━━━━━━━━━━━━━━━━━
💰 *Total Invested:* $${totalInvested.toFixed(2)}
💵 *Current Portfolio Value:* $${totalCurrentValue.toFixed(2)} (${overallPnLSign}$${overallPnL.toFixed(2)})

*🟢 ACTIVE HOLDINGS (Checking Live):*
${activeText || "None"}

*📜 CLOSED POSITIONS:*
${closedText || "None"}`;
}

// ==========================================
// 2. SIMULATION ENGINE
// ==========================================

async function processIncomingCall(ca, source = "Channel Call") {
  // Check if position already exists in active holdings
  const existing = portfolio.find((p) => p.ca.toLowerCase() === ca.toLowerCase() && p.status === "HOLDING");
  if (existing) {
    console.log(`[Skip] Already tracking active position for CA: ${ca}`);
    return;
  }

  const tokenData = await getTokenDataFromDexScreener(ca);
  if (!tokenData || !tokenData.price || tokenData.price <= 0) {
    console.log(`[Error] Could not retrieve price for CA: ${ca}`);
    return;
  }

  const investedAmount = 1.0; // Fixed $1 simulate buy
  const tokensBought = investedAmount / tokenData.price;

  const newPosition = {
    id: Date.now().toString(),
    ca: ca,
    symbol: tokenData.symbol,
    name: tokenData.name,
    chain: tokenData.chain,
    invested: investedAmount,
    entryPrice: tokenData.price,
    currentPrice: tokenData.price,
    tokensBought: tokensBought,
    currentValue: investedAmount,
    exitPrice: null,
    exitValue: null,
    status: "HOLDING",
    createdAt: new Date().toLocaleTimeString(),
  };

  portfolio.push(newPosition);

  // Announce execution in Telegram console or logs
  console.log(`\n🚀 [BUY SIMULATED] ${tokenData.symbol} ($1.00 @ $${tokenData.price})`);

  // Start continuous monitoring loop for this position
  monitorPosition(newPosition.id);
}

function monitorPosition(id) {
  const interval = setInterval(async () => {
    const position = portfolio.find((p) => p.id === id);

    if (!position || position.status !== "HOLDING") {
      clearInterval(interval);
      return;
    }

    const liveData = await getTokenDataFromDexScreener(position.ca);
    if (!liveData || !liveData.price) return;

    position.currentPrice = liveData.price;
    position.currentValue = position.tokensBought * position.currentPrice;

    const multiplier = position.currentPrice / position.entryPrice;

    // Take Profit Condition: 2x Profit (>= 2.0x / 100% Gain)
    if (multiplier >= 2.0) {
      position.status = "SOLD (2x Profit 🎉)";
      position.exitPrice = position.currentPrice;
      position.exitValue = position.currentValue;
      console.log(`🎯 [TAKE PROFIT 2x HIT] $${position.symbol} sold at ${multiplier.toFixed(2)}x!`);
      clearInterval(interval);
    }
    // Stop Loss Condition: 50% Loss (<= 0.5x)
    else if (multiplier <= 0.5) {
      position.status = "SOLD (50% Loss 🛑)";
      position.exitPrice = position.currentPrice;
      position.exitValue = position.currentValue;
      console.log(`🛑 [STOP LOSS HIT] $${position.symbol} sold at ${multiplier.toFixed(2)}x (-50%)`);
      clearInterval(interval);
    }
  }, 10000); // Check DexScreener every 10 seconds
}

// ==========================================
// 3. TELEGRAM LISTENERS & COMMANDS
// ==========================================

// Listen to incoming channel posts (or group messages)
bot.on("channel_post", async (msg) => {
  const ca = extractCAFromMessage(msg);
  if (ca) {
    console.log(`[TG Channel Call Detected] CA: ${ca}`);
    await processIncomingCall(ca, "Channel Post");
  }
});

// Also listen to direct group or private messages
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return; // Ignore slash commands

  const ca = extractCAFromMessage(msg);
  if (ca) {
    console.log(`[TG Message Call Detected] CA: ${ca}`);
    await processIncomingCall(ca, "Direct Message");
  }
});

// Telegram Command: /portfolio
bot.onText(/\/portfolio/, (msg) => {
  const text = formatPortfolioMessage();
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// ==========================================
// 4. REST API ENDPOINTS & EXPRESS SERVER
// ==========================================

app.get("/health", (req, res) => res.send("OK - Bot is running 24/7"));

app.get("/api/portfolio", (req, res) => {
  res.json(portfolio);
});

// Manual trigger via API
app.post("/api/simulate", async (req, res) => {
  const { dexscreenerLink } = req.body;
  const caRegex = /0x[a-fA-F0-9]{40}/;
  const match = dexscreenerLink ? dexscreenerLink.match(caRegex) : null;

  if (!match) return res.status(400).json({ error: "No valid CA found in link." });

  await processIncomingCall(match[0], "API Manual Request");
  res.json({ success: true, message: `Simulation started for CA: ${match[0]}` });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Simulation Engine & TG Bot running on port ${PORT}`);
});