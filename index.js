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

for (const key of ["ACCOUNT_NAME", "PASSWORD", "GAMES", "SHARED_SECRET"]) {
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
let userIsProbablyPlaying = false;

let retryAttempt = 0;
let retryTimer = null;
let resumeTimer = null;
let lastFarmLogAt = 0;

const MIN_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;
const FARM_INTERVAL_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const FARM_LOG_COOLDOWN_MS = 10 * 60_000;

// задержка после твоей игры, чтобы бот не лез сразу
const RESUME_AFTER_PLAYING_MS = 5 * 60_000;

function nowRu() {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Asia/Aqtobe",
    hour12: false,
  });
}

async function tg(message) {
  const text = `🕒 ${nowRu()}\n${message}`;

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
        parse_mode: "HTML",
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

function stopFarming() {
  try {
    client.gamesPlayed([]);
  } catch (_) {}
}

function scheduleReconnect(reason) {
  if (retryTimer) return;

  loggedIn = false;
  loggingIn = false;

  // ВАЖНО: если ты сейчас играешь — бот НЕ долбится в Steam
  if (pausedByOtherSession || userIsProbablyPlaying) {
    tg(
      `⏸ <b>Реконнект отложен</b>\n\n` +
        `🎮 Похоже, ты сейчас играешь.\n` +
        `🛡 Бот не будет спамить логинами в Steam.\n\n` +
        `📌 Причина: <code>${reason}</code>`
    );
    return;
  }

  const delay = retryDelay();

  tg(
    `🔁 <b>Переподключение запланировано</b>\n\n` +
      `⏳ Через: <b>${Math.round(delay / 1000)} сек.</b>\n` +
      `📌 Причина: <code>${reason}</code>`
  );

  retryTimer = setTimeout(() => {
    retryTimer = null;
    login();
  }, delay);
}

function scheduleResumeAfterPlaying() {
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }

  tg(
    `🕊 <b>Игра завершена</b>\n\n` +
      `Бот подождёт <b>${Math.round(RESUME_AFTER_PLAYING_MS / 60000)} мин.</b>, ` +
      `чтобы не выглядеть подозрительно для Steam.\n\n` +
      `После паузы фарм восстановится автоматически.`
  );

  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    userIsProbablyPlaying = false;
    pausedByOtherSession = false;

    tg(
      `✅ <b>Пауза закончилась</b>\n\n` +
        `Пробую восстановить фарм часов.`
    );

    if (!loggedIn && !loggingIn) {
      login();
      return;
    }

    farm(true);
  }, RESUME_AFTER_PLAYING_MS);
}

function farm(forceLog = false) {
  if (!loggedIn) return;
  if (pausedByOtherSession || userIsProbablyPlaying) return;

  client.gamesPlayed(games);
  client.setPersona(Number(PERSONA));

  const shouldLog =
    forceLog || Date.now() - lastFarmLogAt > FARM_LOG_COOLDOWN_MS;

  if (shouldLog) {
    lastFarmLogAt = Date.now();

    tg(
      `🌾 <b>Фарм активен</b>\n\n` +
        `🎮 Игры: <code>${games.join(", ")}</code>\n` +
        `👤 Статус Steam: <code>${PERSONA}</code>`
    );
  }
}

function login() {
  if (loggedIn || loggingIn) return;

  if (pausedByOtherSession || userIsProbablyPlaying) {
    tg(
      `⏸ <b>Вход в Steam отменён</b>\n\n` +
        `🎮 Ты сейчас играешь или бот ждёт после твоей игры.\n` +
        `Бот не будет перебивать твою сессию.`
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

  tg(
    `✅ <b>Steam подключён</b>\n\n` +
      `🆔 Аккаунт: <code>${client.steamID}</code>\n` +
      `🚀 Бот готов фармить часы.`
  );

  farm(true);
});

client.on("playingState", (blocked) => {
  pausedByOtherSession = blocked;

  if (blocked) {
    userIsProbablyPlaying = true;
    stopFarming();

    tg(
      `🎮 <b>Ты начал играть</b>\n\n` +
        `⏸ Фарм остановлен.\n` +
        `🛡 Бот не будет реконнектиться, пока ты играешь.`
    );

    return;
  }

  scheduleResumeAfterPlaying();
});

client.on("disconnected", (eresult, msg) => {
  stopFarming();

  const reason = msg || eresult || "unknown";

  if (reason === "LoggedInElsewhere" || String(reason).includes("LoggedInElsewhere")) {
    userIsProbablyPlaying = true;

    tg(
      `🎮 <b>Steam сессия занята</b>\n\n` +
        `Похоже, ты вошёл в Steam или запустил игру.\n` +
        `⏸ Бот уходит в режим ожидания и не будет долбиться в логин.\n\n` +
        `📌 Причина: <code>${reason}</code>`
    );

    scheduleResumeAfterPlaying();
    return;
  }

  scheduleReconnect(`disconnected: ${reason}`);
});

client.on("error", (err) => {
  stopFarming();

  const reason = err.message || String(err);

  if (reason.includes("LoggedInElsewhere")) {
    userIsProbablyPlaying = true;

    tg(
      `🎮 <b>Бот выкинут другой Steam-сессией</b>\n\n` +
        `Это нормально, если ты сам запустил игру.\n` +
        `⏸ Реконнект отложен.\n\n` +
        `📌 Ошибка: <code>${reason}</code>`
    );

    scheduleResumeAfterPlaying();
    return;
  }

  scheduleReconnect(`error: ${reason}`);
});

client.on("steamGuard", () => {
  tg(
    `⚠️ <b>Steam Guard запросил код</b>\n\n` +
      `Проверь переменную:\n` +
      `<code>SHARED_SECRET</code>\n\n` +
      `Она должна быть именно из поля <code>shared_secret</code> в maFile.`
  );
});

setInterval(() => {
  if (!loggedIn && !loggingIn && !pausedByOtherSession && !userIsProbablyPlaying) {
    scheduleReconnect("watchdog: bot is not logged in");
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
        `📦 Railway контейнер активен.`
    );
  });
