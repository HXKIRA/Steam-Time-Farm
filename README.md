# 🌾 Steam Hour Farmer (Railway)

A simple Steam hour farming bot that runs 24/7 on Railway.

It logs into Steam automatically, farms selected games, pauses when you play, and sends logs to Telegram.

> ⚠️ Use at your own risk. It’s recommended to use a secondary Steam account.

---

## ✨ Features

- 🌾 Farm hours in Steam games (AppID)
- 🔐 Auto-login using Steam Guard (`shared_secret`)
- 🔁 Auto-reconnect
- 🎮 Stops when you start playing
- 🕊 Waits before reconnecting (safe behavior)
- 💬 Telegram logs
- 🚀 Ready for Railway (Docker)

---

## ⚙️ Environment Variables

Set them in Railway → **Service → Variables**

### Required

```env
ACCOUNT_NAME=your_steam_login
PASSWORD=your_password
GAMES=730,440
SHARED_SECRET=xxxxxxxx
STEAM_DATA_DIR=/data/SteamData
