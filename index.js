require("dotenv").config();

const SteamUser = require("steam-user");
const SteamTotp = require("steam-totp");
const http = require("http");

const {
  ACCOUNT_NAME,
  PASSWORD,
  GAMES,
  PERSONA = "1",
  SHARED_SECRET,
  PORT = 3000,
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  STEAM_DATA_DIR = "./SteamData",
} = process.env;

const required = ["ACCOUNT_NAME", "PASSWORD", "GAMES", "SHARED_SECRET"];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

const games = GAMES.split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => {
    const n = Number(x);
    return Number.isNaN(n) ? x : n;
  });

const client = new SteamUser({
  machineIdType: SteamUser.EMachineIDType.PersistentRandom,
  dataDirectory: STEAM_DATA_DIR,
  renewRefreshTokens: true,
});

let loggedIn = false;
let loggingIn = false;
let pausedByOtherSession = false;

let retryAttempt = 0;
let retryTimer = null;
let lastFarmLogAt = 0;

const MIN_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;
const FARM_INTERVAL_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const FARM_LOG_COOLDOWN_MS = 10 * 60_000;

function now() {
  return new Date().toISOString();
}

async function tg(message) {
  const text = `[${now()}]\n${message}`;

  console.log(text);

  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: text.slice(0, 3900),
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("Telegram log failed:", err.message || err);
  }
}

function retryDelay() {
  const delay = Math.min(MIN_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
  retryAttempt += 1;
  return delay;
}

function resetRetry() {
  retryAttempt = 0;

  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleReconnect(reason) {
  if (retryTimer) return;

  loggedIn = false;
  loggingIn = false;

  const delay = retryDelay();

  tg(`🔁 Повторное подключение запланировано через ${Math.round(delay / 1000)}s\nПричина: ${reason}`);

  retryTimer = setTimeout(() => {
    retryTimer = null;
    login();
  }, delay);
}

function farm(forceLog = false) {
  if (!loggedIn) return;

  if (pausedByOtherSession) {
    return;
  }

  client.gamesPlayed(games);
  client.setPersona(Number(PERSONA));

  const shouldLog =
    forceLog || Date.now() - lastFarmLogAt > FARM_LOG_COOLDOWN_MS;

  if (shouldLog) {
    lastFarmLogAt = Date.now();
    tg(`🌾 Farming active\nGames: ${games.join(", ")}`);
  }
}

function stopFarming() {
  try {
    client.gamesPlayed([]);
  } catch (_) {}
}

function login() {
  if (loggedIn || loggingIn) return;

  loggingIn = true;

  try {
    tg("🔐 Вход в Steam...");

    client.logOn({
      accountName: ACCOUNT_NAME,
      password: PASSWORD,
      twoFactorCode: SteamTotp.generateAuthCode(SHARED_SECRET),
      machineName: "railway-steam-hour-farmer",
      clientOS: SteamUser.EOSType.Windows10,
      autoRelogin: true,
    });
  } catch (err) {
    scheduleReconnect(err.message || "logOn failed");
  }
}

client.on("loggedOn", () => {
  loggedIn = true;
  loggingIn = false;
  resetRetry();

  tg(`✅ Вошел в Steam как ${client.steamID}`);
  farm(true);
});

client.on("playingState", (blocked) => {
  pausedByOtherSession = blocked;

  if (blocked) {
    stopFarming();
    tg("🎮 Вы начали играть. Бот приостановил фарм.");
  } else {
    tg("✅ Ваша игровая сессия завершилась. Бот возобновляет фарм.");
    farm(true);
  }
});

client.on("disconnected", (eresult, msg) => {
  stopFarming();
  scheduleReconnect(`disconnected: ${msg || eresult || "unknown"}`);
});

client.on("error", (err) => {
  stopFarming();
  scheduleReconnect(`error: ${err.message || err}`);
});

client.on("steamGuard", () => {
  tg("⚠️ Запрос на использование Steam Guard. Проверьте ваш SHARED_SECRET.");
});

setInterval(() => {
  if (!loggedIn && !loggingIn) {
    scheduleReconnect("watchdog: not logged in");
  }
}, WATCHDOG_INTERVAL_MS);

setInterval(() => {
  farm(false);
}, FARM_INTERVAL_MS);

login();

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
    });

    res.end(
      JSON.stringify({
        ok: true,
        loggedIn,
        loggingIn,
        pausedByOtherSession,
        games,
        retryAttempt,
        time: now(),
      })
    );
  })
  .listen(PORT, () => {
    tg(`🚀 Сервер проверки работоспособности запущен на порту ${PORT}`);
  });
