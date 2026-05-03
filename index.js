require("dotenv").config();

const SteamUser = require("steam-user");
const SteamTotp = require("steam-totp");
const http = require("http");
const fs = require("fs");
const path = require("path");

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

for (const key of ["ACCOUNT_NAME", "PASSWORD", "GAMES", "SHARED_SECRET"]) {
  if (!process.env[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

fs.mkdirSync(STEAM_DATA_DIR, { recursive: true });

const CONFIG_PATH = path.join(STEAM_DATA_DIR, "bot-config.json");

function parseGames(value) {
  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const n = Number(x);
      return Number.isNaN(n) ? x : n;
    });
}

function loadGames() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (Array.isArray(saved.games) && saved.games.length) return saved.games;
    }
  } catch (_) {}

  return parseGames(GAMES);
}

function saveGames() {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ games, updatedAt: new Date().toISOString() }, null, 2)
  );
}

let games = loadGames();

const client = new SteamUser({
  machineIdType: SteamUser.EMachineIDType.PersistentRandom,
  dataDirectory: STEAM_DATA_DIR,
  renewRefreshTokens: true,
});

let loggedIn = false;
let loggingIn = false;
let farmingEnabled = false;

let pausedByOtherSession = false;
let userIsProbablyPlaying = false;

let retryAttempt = 0;
let retryTimer = null;
let readyTimer = null;
let lastFarmLogAt = 0;
let lastKickTime = 0;
let tgOffset = null;

const notifyCache = new Map();

const MIN_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;
const FARM_INTERVAL_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const FARM_LOG_COOLDOWN_MS = 10 * 60_000;
const READY_AFTER_PLAYING_MS = 5 * 60_000;
const KICK_PROTECTION_MS = 10 * 60_000;
const DUPLICATE_MESSAGE_TTL_MS = 15_000;

function nowRu() {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Asia/Aqtobe",
    hour12: false,
  });
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function tg(message) {
  const text = `🕒 ${nowRu()}\n${message}`;

  console.log(text);

  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: text.slice(0, 3900),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("Telegram log failed:", err.message || err);
  }
}

async function notifyOnce(key, message, ttlMs = DUPLICATE_MESSAGE_TTL_MS) {
  const lastAt = notifyCache.get(key) || 0;

  if (Date.now() - lastAt < ttlMs) return;

  notifyCache.set(key, Date.now());
  await tg(message);
}

async function initTelegramOffset() {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    tgOffset = 0;
    return;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates`
    );
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
      tgOffset = 0;
      return;
    }

    const lastUpdate = data.result[data.result.length - 1];
    tgOffset = lastUpdate.update_id + 1;

    console.log(`Telegram offset initialized: ${tgOffset}`);
  } catch (err) {
    tgOffset = 0;
    console.error("Telegram offset init failed:", err.message || err);
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

function stopFarming() {
  try {
    client.gamesPlayed([]);
  } catch (_) {}
}

function canFarm() {
  const recentlyKicked = Date.now() - lastKickTime < KICK_PROTECTION_MS;

  return (
    loggedIn &&
    farmingEnabled &&
    !pausedByOtherSession &&
    !userIsProbablyPlaying &&
    !recentlyKicked
  );
}

function scheduleReconnect(reason) {
  if (retryTimer) return;

  loggedIn = false;
  loggingIn = false;

  if (!farmingEnabled) {
    notifyOnce(
      "reconnect-disabled",
      `⏸ <b>Реконнект не нужен</b>\n\n` +
        `Фарм выключен. Бот не будет заходить в Steam сам.\n\n` +
        `📌 Причина: <code>${escapeHtml(reason)}</code>`,
      60_000
    );
    return;
  }

  if (pausedByOtherSession || userIsProbablyPlaying) {
    notifyOnce(
      "reconnect-playing",
      `⏸ <b>Реконнект отложен</b>\n\n` +
        `🎮 Похоже, ты сейчас играешь.\n` +
        `🛡 Бот не будет спамить логинами.\n\n` +
        `📌 Причина: <code>${escapeHtml(reason)}</code>`,
      60_000
    );
    return;
  }

  const delay = retryDelay();

  tg(
    `🔁 <b>Переподключение запланировано</b>\n\n` +
      `⏳ Через: <b>${Math.round(delay / 1000)} сек.</b>\n` +
      `📌 Причина: <code>${escapeHtml(reason)}</code>`
  );

  retryTimer = setTimeout(() => {
    retryTimer = null;
    login();
  }, delay);
}

function markPlayingAndDisableFarm(reason) {
  farmingEnabled = false;
  userIsProbablyPlaying = true;
  pausedByOtherSession = true;
  lastKickTime = Date.now();
  stopFarming();

  notifyOnce(
    "playing-detected",
    `🎮 <b>Обнаружена другая Steam-сессия</b>\n\n` +
      `Фарм остановлен.\n` +
      `Бот не будет запускаться сам.\n\n` +
      `📌 Причина: <code>${escapeHtml(reason)}</code>\n\n` +
      `Чтобы снова фармить после игры, напиши <code>/farm</code>.`,
    60_000
  );

  scheduleReadyAfterPlaying();
}

function scheduleReadyAfterPlaying() {
  if (readyTimer) clearTimeout(readyTimer);

  readyTimer = setTimeout(() => {
    readyTimer = null;
    userIsProbablyPlaying = false;
    pausedByOtherSession = false;

    notifyOnce(
      "ready-after-playing",
      `✅ <b>Бот снова готов</b>\n\n` +
        `Фарм выключен.\n` +
        `Для запуска напиши <code>/farm</code>.`,
      60_000
    );
  }, READY_AFTER_PLAYING_MS);
}

function farm(forceLog = false) {
  if (!canFarm()) return;

  client.setPersona(Number(PERSONA));
  client.gamesPlayed(games);

  const shouldLog =
    forceLog || Date.now() - lastFarmLogAt > FARM_LOG_COOLDOWN_MS;

  if (shouldLog) {
    lastFarmLogAt = Date.now();

    tg(
      `🌾 <b>Фарм активен</b>\n\n` +
        `🎮 Игры: <code>${escapeHtml(games.join(", "))}</code>\n` +
        `👤 Статус Steam: <code>${escapeHtml(PERSONA)}</code>\n\n` +
        `Остановить: <code>/stop</code>`
    );
  }
}

function login() {
  if (loggedIn || loggingIn) return;

  if (!farmingEnabled) {
    notifyOnce(
      "login-disabled",
      `⏸ <b>Вход в Steam не выполнен</b>\n\n` +
        `Фарм выключен.\n` +
        `Чтобы начать, напиши <code>/farm</code>.`,
      60_000
    );
    return;
  }

  if (pausedByOtherSession || userIsProbablyPlaying) {
    notifyOnce(
      "login-playing",
      `⏸ <b>Вход в Steam отменён</b>\n\n` +
        `🎮 Ты сейчас играешь или бот ждёт после твоей игры.`,
      60_000
    );
    return;
  }

  loggingIn = true;

  try {
    tg(`🔐 <b>Вход в Steam...</b>`);

    client.logOn({
      accountName: ACCOUNT_NAME,
      password: PASSWORD,
      twoFactorCode: SteamTotp.generateAuthCode(SHARED_SECRET),
      machineName: "railway-steam-time-farm",
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

  tg(
    `✅ <b>Steam подключён</b>\n\n` +
      `🆔 Аккаунт: <code>${client.steamID}</code>\n` +
      `🌾 Фарм включён: <code>${farmingEnabled ? "да" : "нет"}</code>`
  );

  farm(true);
});

client.on("playingState", (blocked) => {
  pausedByOtherSession = blocked;

  if (blocked) {
    markPlayingAndDisableFarm("playingState: blocked");
    return;
  }

  // blocked=false — это просто Steam сообщил, что блокировки нет.
  // Не выключаем фарм и не пишем “игра завершена”.
  pausedByOtherSession = false;
});

client.on("disconnected", (eresult, msg) => {
  stopFarming();

  const reason = String(msg || eresult || "unknown");

  if (reason.includes("LoggedInElsewhere")) {
    loggedIn = false;
    loggingIn = false;
    markPlayingAndDisableFarm(reason);
    return;
  }

  scheduleReconnect(`disconnected: ${reason}`);
});

client.on("error", (err) => {
  stopFarming();

  const reason = String(err.message || err);

  if (reason.includes("LoggedInElsewhere")) {
    loggedIn = false;
    loggingIn = false;
    markPlayingAndDisableFarm(reason);
    return;
  }

  scheduleReconnect(`error: ${reason}`);
});

client.on("steamGuard", () => {
  notifyOnce(
    "steamguard",
    `⚠️ <b>Steam Guard запросил код</b>\n\n` +
      `Проверь переменную <code>SHARED_SECRET</code>.\n` +
      `Она должна быть именно из поля <code>shared_secret</code> в maFile.`,
    60_000
  );
});

async function sendHelp() {
  await tg(
    `🤖 <b>Команды</b>\n\n` +
      `<code>/farm</code> — начать фарм\n` +
      `<code>/stop</code> — остановить фарм\n` +
      `<code>/status</code> — статус\n` +
      `<code>/games</code> — текущие игры\n` +
      `<code>/setgames 730,440</code> — сменить игры\n` +
      `<code>/help</code> — помощь`
  );
}

async function handleTelegramCommand(text, chatId) {
  if (String(chatId) !== String(TG_CHAT_ID)) return;

  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const argText = args.join(" ");

  if (cmd === "/help" || cmd === "/start") {
    await sendHelp();
    return;
  }

  if (cmd === "/status") {
    const recentlyKicked = Date.now() - lastKickTime < KICK_PROTECTION_MS;

    await tg(
      `📊 <b>Статус</b>\n\n` +
        `Steam: <code>${loggedIn ? "подключён" : "не подключён"}</code>\n` +
        `Логинится: <code>${loggingIn ? "да" : "нет"}</code>\n` +
        `Фарм включён: <code>${farmingEnabled ? "да" : "нет"}</code>\n` +
        `Ты играешь: <code>${userIsProbablyPlaying ? "возможно да" : "нет"}</code>\n` +
        `Защита после кика: <code>${recentlyKicked ? "активна" : "нет"}</code>\n` +
        `Игры: <code>${escapeHtml(games.join(", "))}</code>`
    );
    return;
  }

  if (cmd === "/games") {
    await tg(
      `🎮 <b>Текущие игры</b>\n\n` +
        `<code>${escapeHtml(games.join(", "))}</code>\n\n` +
        `Изменить:\n<code>/setgames 730,440,4000</code>`
    );
    return;
  }

  if (cmd === "/setgames") {
    const nextGames = parseGames(argText);

    if (!nextGames.length) {
      await tg(
        `❌ <b>Неверный формат</b>\n\n` +
          `Пример:\n<code>/setgames 730,440,4000</code>`
      );
      return;
    }

    games = nextGames;
    saveGames();
    stopFarming();

    await tg(
      `✅ <b>Игры обновлены</b>\n\n` +
        `🎮 Новый список: <code>${escapeHtml(games.join(", "))}</code>`
    );

    if (farmingEnabled) farm(true);
    return;
  }

  if (cmd === "/stop") {
    farmingEnabled = false;
    stopFarming();

    await tg(
      `⏹ <b>Фарм остановлен</b>\n\n` +
        `Чтобы снова начать:\n<code>/farm</code>`
    );
    return;
  }

  if (cmd === "/farm") {
    farmingEnabled = true;
    userIsProbablyPlaying = false;
    pausedByOtherSession = false;
    lastKickTime = 0;

    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }

    await tg(
      `🌾 <b>Фарм включён вручную</b>\n\n` +
        `🎮 Игры: <code>${escapeHtml(games.join(", "))}</code>`
    );

    if (!loggedIn && !loggingIn) {
      login();
    } else {
      farm(true);
    }

    return;
  }

  await tg(`❓ Неизвестная команда.\n\nНапиши <code>/help</code>`);
}

async function pollTelegram() {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  if (tgOffset === null) return;

  try {
    const url =
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates` +
      `?timeout=20&offset=${tgOffset}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      tgOffset = update.update_id + 1;

      const msg = update.message;
      if (!msg || !msg.text) continue;

      await handleTelegramCommand(msg.text, msg.chat.id);
    }
  } catch (err) {
    console.error("Telegram polling failed:", err.message || err);
  }
}

setInterval(() => {
  if (
    !loggedIn &&
    !loggingIn &&
    farmingEnabled &&
    !pausedByOtherSession &&
    !userIsProbablyPlaying
  ) {
    scheduleReconnect("watchdog: bot is not logged in");
  }
}, WATCHDOG_INTERVAL_MS);

setInterval(() => {
  farm(false);
}, FARM_INTERVAL_MS);

setInterval(() => {
  pollTelegram();
}, 3000);

initTelegramOffset();

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });

    res.end(
      JSON.stringify({
        ok: true,
        loggedIn,
        loggingIn,
        farmingEnabled,
        pausedByOtherSession,
        userIsProbablyPlaying,
        games,
        retryAttempt,
        time: nowRu(),
      })
    );
  })
  .listen(PORT, () => {
    tg(
      `🚀 <b>Бот запущен</b>\n\n` +
        `🌐 Healthcheck порт: <code>${PORT}</code>\n` +
        `📦 Railway контейнер активен.\n\n` +
        `Фарм выключен по умолчанию.\n` +
        `Напиши <code>/farm</code>, чтобы начать.`
    );
  });
