# 🌾 Steam Hour Farmer (Railway)

A simple Steam hour farming bot that runs 24/7 on Railway.

It logs into Steam automatically, farms selected games, pauses when you
play, and sends logs to Telegram.

> ⚠️ Use at your own risk. It's recommended to use a secondary Steam
> account.



## ✨ Features

-   Farm hours in Steam games (AppID)
-   Auto-login using Steam Guard (`shared_secret`)
-   Auto-reconnect
-   Stops when you start playing
-   Waits before reconnecting (safe behavior)
-   Telegram logs
-   Ready for Railway



## ⚙️ Environment Variables

Set them in Railway → **Service → Variables**

### Required

| Variable | Description | Example |
|--------|------------|--------|
| `ACCOUNT_NAME` | Your Steam login (not nickname) | `your_steam_login` |
| `PASSWORD` | Your Steam password | `your_steam_password` |
| `GAMES` | AppIDs separated by comma | `730,440` |
| `SHARED_SECRET` | Steam Guard shared_secret from `.maFile` | `xxxxxxxx` |
| `STEAM_DATA_DIR` | Session storage path (do not change) | `/data/SteamData` |
| `PERSONA` | Steam status (1 = Online) | `1` |


### Optional (Telegram)

| Variable | Description | Example |
|--------|------------|--------|
| `TG_BOT_TOKEN` | Telegram bot token | `123456:ABC...` |
| `TG_CHAT_ID` | Your Telegram chat ID | `123456789` |



## 🎮 Games Format

`GAMES=730,440,4000`

How to find AppID:\
https://steamcommunity.com/app/240 → 240 = AppID



## 🔑 Getting SHARED_SECRET

From `.maFile`:

"shared_secret": "XXXXXXXX="

Use only the value.

[Guide](https://vk.com/@vboost1-nastroika-steamdesktopauthenticator-dlya-uproscheniya-sozdan)



## 🤖 Telegram Setup

1.  Create bot via @BotFather\
2.  Send /start\
3.  Get chat ID via:\
    https://api.telegram.org/botYOUR_TOKEN/getUpdates



## 🚀 Deploy

1.  Push to GitHub
2.  Deploy in [Railway](https://railway.com/)
3.  Add variables
4.  Redeploy



## 💬 Behavior

bot farming → you play → bot stops\
you exit → bot waits → resumes


## ❌ Common Issues

InvalidPassword → wrong login/password/secret\
RateLimitExceeded → wait 30--60 min\
No logs → check token/chat_id

Test: https://api.telegram.org/botTOKEN/getMe

