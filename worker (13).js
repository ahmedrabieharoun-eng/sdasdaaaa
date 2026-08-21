/* ============================================================
 * Gram Drop — Cloudflare Worker backend
 * ------------------------------------------------------------
 * Implements the /api/* contract expected by the GramDrop
 * Telegram Mini App frontend (gramdrop_merged__2_.html).
 *
 * Bindings required (see wrangler.toml):
 *   - KV namespace binding: GD_KV
 *   - Secret:  BOT_TOKEN     -> Telegram bot token (for initData check)
 *   - Secret:  ADMIN_SECRET  -> bearer token protecting /api/admin/*
 *   - (optional) var: DEBUG = "1" to allow X-Debug-Tg-Id header
 *     instead of real Telegram initData, for local testing only.
 *
 * Storage model (Workers KV):
 *   user:<tgId>          -> user JSON record
 *   device:<deviceId>    -> tgId this device is bound to
 *   refcode:<code>       -> tgId that owns this referral code
 *   config               -> admin-editable economy/app config
 *   tasks                -> array of task definitions
 *   promo:<code>         -> promo code record
 *   nonce:<nonce>        -> short-lived ad/game session proof
 *   withdrawals          -> array of withdrawal requests (admin view)
 * ============================================================ */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-InitData, X-Device-Id, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      ...extra,
    },
  });

const err = (code, status = 400, data = {}) => json({ error: code, ...data }, status);

const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

function randCode(len = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

function nonceId() {
  return crypto.randomUUID().replace(/-/g, "");
}

/* ---------------- Telegram initData verification ----------------
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
async function hmacSha256(keyBytes, msg) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const computed = toHex(await hmacSha256(secretKey, dataCheckString));

  if (computed !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // >24h old, reject

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {}
  if (!user || !user.id) return null;

  return {
    id: String(user.id),
    username: user.username || "",
    firstName: user.first_name || "",
    startParam: params.get("start_param") || "",
  };
}

/* ---------------- config / defaults ---------------- */

function defaultConfig() {
  return {
    app: {
      appName: "Gram Drop",
      appShortName: "gramdrop",
      botUsername: "GramDropBot",
      currency: "GD",
      logoUrl: "",
      announcement: "",
      supportUrl: "",
      tickerEnabled: true,
      tickerMax: 20,
      maintenanceMsg: "Under maintenance — back shortly",
      requireChannels: [], // [{id:"@channel", url:"https://t.me/channel", title:"Our Channel"}]
      requireUsername: false,
    },
    maintenance: false,
    economy: {
      adReward: 50,
      dailyBonus: 100,
      gdPerUsd: 200000,
      refPercent: 10,
      activeAdsRequired: 1, // ads a referral must watch to count as "active"
      inviteActive: true,
    },
    ads: {
      monetagZoneId: "",
      monetagSdkUrl: "https://libtl.com/sdk.js",
      openAdEnabled: true,
      fallbackToSimulated: true,
      cooldownSecs: 30,
      claimCooldownSecs: 30,
      minWatchSecs: 5,
      clicksRequired: 0,
      dailyAdLimit: 100,
    },
    games: {
      dailyPlaysPerGame: 3,
      maxRewardCatch: 200,
      maxRewardMerge: 300,
      maxRewardFlappy: 200,
      maxRewardWhack: 250,
    },
    withdraw: {
      minWithdrawUsd: 1,
      feeUsd: 0,
      unlockAds: 10,
      unlockRefs: 2,
      cooldownHours: 24,
      enabled: true,
    },
  };
}

async function getConfig(env) {
  const raw = await env.GD_KV.get("config", "json");
  if (!raw) {
    const cfg = defaultConfig();
    await env.GD_KV.put("config", JSON.stringify(cfg));
    return cfg;
  }
  // shallow-merge with defaults so newly added fields don't break old data
  const def = defaultConfig();
  return {
    app: { ...def.app, ...raw.app },
    maintenance: raw.maintenance ?? def.maintenance,
    economy: { ...def.economy, ...raw.economy },
    ads: { ...def.ads, ...raw.ads },
    games: { ...def.games, ...raw.games },
    withdraw: { ...def.withdraw, ...raw.withdraw },
  };
}

async function getTasks(env) {
  const tasks = await env.GD_KV.get("tasks", "json");
  return tasks || [];
}

/* ---------------- user record ---------------- */

function newUser(tgId, username, refCode, referredBy) {
  const now = Date.now();
  return {
    tgId,
    username,
    balance: 0,
    refCode,
    referredBy: referredBy || null,
    activeRefs: 0,
    referrals: [], // [{tgId, username, active, joinedAt}]
    adsToday: 0,
    adsTotal: 0,
    adCounters: {}, // {rewarded: n, monetag: n, ...} per-network today
    lastAdDay: todayKey(),
    dailyBonusClaimed: false,
    lastBonusDay: null,
    playsLeft: {}, // {game: n}
    lastPlayDay: todayKey(),
    walletTon: "",
    walletUsdt: "",
    withdrawNextAt: 0,
    withdrawals: [],
    pendingClaim: null, // {sessionId, game, reward}
    tasksDone: {}, // {taskId: true}
    tasksStarted: {}, // {taskId: timestamp}
    joinedChannels: {},
    banned: false,
    banReason: "",
    createdAt: now,
    updatedAt: now,
  };
}

async function getUser(env, tgId) {
  return env.GD_KV.get("user:" + tgId, "json");
}
async function saveUser(env, user) {
  user.updatedAt = Date.now();
  await env.GD_KV.put("user:" + user.tgId, JSON.stringify(user));
}

/* Resets daily counters when the UTC day rolls over. */
function rollDaily(user, cfg) {
  const today = todayKey();
  if (user.lastAdDay !== today) {
    user.adsToday = 0;
    user.adCounters = {};
    user.lastAdDay = today;
  }
  if (user.lastBonusDay !== today) {
    user.dailyBonusClaimed = false;
  }
  if (user.lastPlayDay !== today) {
    user.playsLeft = {};
    user.lastPlayDay = today;
  }
}

async function getOrCreateUser(env, tg, deviceId, startParam) {
  let user = await getUser(env, tg.id);
  if (user) return user;

  // brand new user
  let refCode = randCode(7);
  while (await env.GD_KV.get("refcode:" + refCode)) refCode = randCode(7);

  let referredBy = null;
  if (startParam) {
    const ownerId = await env.GD_KV.get("refcode:" + startParam);
    if (ownerId && ownerId !== tg.id) referredBy = ownerId;
  }

  user = newUser(tg.id, tg.username, refCode, referredBy);
  await env.GD_KV.put("refcode:" + refCode, tg.id);
  await saveUser(env, user);

  if (referredBy) {
    const refUser = await getUser(env, referredBy);
    if (refUser) {
      refUser.referrals.push({ tgId: tg.id, username: tg.username, active: false, joinedAt: Date.now() });
      await saveUser(env, refUser);
    }
  }
  return user;
}

/* ---------------- client-safe view builders ---------------- */

function publicConfig(cfg) {
  // strip nothing sensitive currently lives in cfg, but keep this seam
  // in case admin-only fields get added later.
  return cfg;
}

function publicUser(user) {
  return {
    tgId: user.tgId,
    balance: user.balance,
    refCode: user.refCode,
    activeRefs: user.activeRefs,
    referrals: user.referrals,
    adsToday: user.adsToday,
    adsTotal: user.adsTotal,
    adCounters: user.adCounters,
    dailyBonusClaimed: user.dailyBonusClaimed,
    playsLeft: user.playsLeft,
    walletTon: user.walletTon,
    walletUsdt: user.walletUsdt,
    withdrawNextAt: user.withdrawNextAt,
    withdrawals: user.withdrawals,
    pendingClaim: user.pendingClaim,
  };
}

function tasksForUser(tasks, user) {
  return tasks
    .filter((t) => t.active !== false)
    .map((t) => {
      let status = null;
      if (user.tasksDone[t.id]) status = "done";
      else if (user.tasksStarted[t.id]) status = "claimable";
      return {
        id: t.id,
        group: t.group,
        icon: t.icon,
        image: t.image || "",
        title: t.title,
        url: t.url,
        reward: t.reward,
        mustJoin: !!t.mustJoin,
        requiresAd: !!t.requiresAd,
        status,
      };
    });
}

/* ---------------- channel membership check (Telegram Bot API) ---------------- */

async function isChannelMember(botToken, channelId, tgUserId) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(
      channelId
    )}&user_id=${encodeURIComponent(tgUserId)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return false;
    const status = data.result && data.result.status;
    return ["creator", "administrator", "member"].includes(status);
  } catch {
    return false;
  }
}

async function checkAllChannels(env, cfg, tgUserId) {
  const channels = cfg.app.requireChannels || [];
  if (!channels.length) return { ok: true, missing: [] };
  const missing = [];
  for (const ch of channels) {
    const joined = await isChannelMember(env.BOT_TOKEN, ch.id, tgUserId);
    if (!joined) missing.push(ch);
  }
  return { ok: missing.length === 0, missing };
}

/* ---------------- auth middleware ---------------- */

async function authenticate(req, env) {
  const initData = req.headers.get("X-Telegram-InitData") || "";
  const deviceId = req.headers.get("X-Device-Id") || "";

  if (env.DEBUG === "1" && req.headers.get("X-Debug-Tg-Id")) {
    return { id: req.headers.get("X-Debug-Tg-Id"), username: "debug_user", firstName: "Debug", deviceId };
  }

  const tg = await verifyInitData(initData, env.BOT_TOKEN);
  if (!tg) return null;
  return { ...tg, deviceId };
}

/* ---------------- nonce store (ad / game session proofs) ---------------- */

async function createNonce(env, payload, ttlSecs = 600) {
  const id = nonceId();
  await env.GD_KV.put("nonce:" + id, JSON.stringify({ ...payload, createdAt: Date.now() }), {
    expirationTtl: ttlSecs,
  });
  return id;
}
async function readNonce(env, id) {
  return env.GD_KV.get("nonce:" + id, "json");
}
async function deleteNonce(env, id) {
  await env.GD_KV.delete("nonce:" + id);
}

/* ---------------- route handlers ---------------- */

async function handleMe(req, env, tg, url) {
  const cfg = await getConfig(env);
  if (cfg.maintenance) return err("maintenance", 503, { message: cfg.app.maintenanceMsg });

  const user = await getOrCreateUser(env, tg, tg.deviceId, tg.startParam || "");

  if (user.banned) return err("banned", 403, { reason: user.banReason });

  if (cfg.app.requireUsername && !tg.username) return err("username_required", 403);

  const gate = await checkAllChannels(env, cfg, tg.id);
  if (!gate.ok) return err("join_required", 403, { channels: gate.missing, app: cfg.app });

  rollDaily(user, cfg);
  await saveUser(env, user);

  const tasks = await getTasks(env);
  return json({
    app: cfg.app,
    economy: cfg.economy,
    ads: cfg.ads,
    games: cfg.games,
    withdraw: cfg.withdraw,
    maintenance: cfg.maintenance,
    me: publicUser(user),
    tasks: tasksForUser(tasks, user),
  });
}

async function handleChannelCheck(req, env, tg) {
  const cfg = await getConfig(env);
  const gate = await checkAllChannels(env, cfg, tg.id);
  if (!gate.ok) return err("join_required", 403, { channels: gate.missing });
  return json({ ok: true });
}

async function handleBonusClaim(req, env, tg, body) {
  const cfg = await getConfig(env);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (user.banned) return err("banned", 403, { reason: user.banReason });
  rollDaily(user, cfg);

  if (user.dailyBonusClaimed) return err("already_claimed", 400);

  // adNonce optional depending on admin setup; if provided, validate it
  if (body.adNonce) {
    const n = await readNonce(env, body.adNonce);
    if (!n || n.tgId !== tg.id || n.purpose !== "bonus" || !n.completed) return err("ad_not_verified", 400);
    await deleteNonce(env, body.adNonce);
  }

  user.balance += Number(cfg.economy.dailyBonus) || 0;
  user.dailyBonusClaimed = true;
  user.lastBonusDay = todayKey();
  await saveUser(env, user);
  return json({ balance: user.balance, reward: cfg.economy.dailyBonus });
}

async function handlePromoRedeem(req, env, tg, body) {
  const code = String(body.code || "").trim().toUpperCase();
  if (!code) return err("invalid_code", 400);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (user.banned) return err("banned", 403, { reason: user.banReason });

  const promo = await env.GD_KV.get("promo:" + code, "json");
  if (!promo) return err("invalid_code", 400);
  if (promo.expiresAt && Date.now() > promo.expiresAt) return err("expired", 400);
  if (promo.redeemedBy && promo.redeemedBy.includes(tg.id)) return err("already_redeemed", 400);
  if (promo.maxUses && (promo.redeemedBy || []).length >= promo.maxUses) return err("exhausted", 400);

  promo.redeemedBy = promo.redeemedBy || [];
  promo.redeemedBy.push(tg.id);
  await env.GD_KV.put("promo:" + code, JSON.stringify(promo));

  user.balance += Number(promo.reward) || 0;
  await saveUser(env, user);
  return json({ balance: user.balance, reward: promo.reward });
}

async function handleTaskStart(req, env, tg, taskId) {
  const tasks = await getTasks(env);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return err("not_ready", 404);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (user.banned) return err("banned", 403, { reason: user.banReason });

  user.tasksStarted[taskId] = Date.now();
  await saveUser(env, user);
  return json({ url: task.url, verifySecs: task.verifySecs || 5 });
}

async function handleTaskVerify(req, env, tg, taskId) {
  const tasks = await getTasks(env);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return err("not_ready", 404);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);

  if (task.mustJoin && task.channelId) {
    const joined = await isChannelMember(env.BOT_TOKEN, task.channelId, tg.id);
    if (!joined) return json({ joined: false });
  }
  return json({ joined: true, available: true });
}

async function handleTaskClaim(req, env, tg, taskId, body) {
  const cfg = await getConfig(env);
  const tasks = await getTasks(env);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return err("not_ready", 404);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (user.banned) return err("banned", 403, { reason: user.banReason });
  if (user.tasksDone[taskId]) return err("already_claimed", 400);
  if (!user.tasksStarted[taskId]) return err("ad_required", 400);

  if (task.mustJoin && task.channelId) {
    const joined = await isChannelMember(env.BOT_TOKEN, task.channelId, tg.id);
    if (!joined) return err("not_joined", 400);
  }

  if (task.requiresAd) {
    if (!body.adNonce) return err("ad_required", 400);
    const n = await readNonce(env, body.adNonce);
    if (!n || n.tgId !== tg.id || n.purpose !== "task" || !n.completed) return err("ad_not_verified", 400);
    await deleteNonce(env, body.adNonce);
  }

  user.tasksDone[taskId] = true;
  user.balance += Number(task.reward) || 0;
  await saveUser(env, user);
  await maybeCreditReferral(env, cfg, user);
  return json({ balance: user.balance, reward: task.reward });
}

/* Credits the referrer once a referred user crosses activeAdsRequired ads. */
async function maybeCreditReferral(env, cfg, user) {
  if (!user.referredBy) return;
  if (user.adsToday < Number(cfg.economy.activeAdsRequired || 1)) return;

  const refUser = await getUser(env, user.referredBy);
  if (!refUser) return;
  const entry = refUser.referrals.find((r) => r.tgId === user.tgId);
  if (entry && !entry.active) {
    entry.active = true;
    refUser.activeRefs = refUser.referrals.filter((r) => r.active).length;
    await saveUser(env, refUser);
  }
}

async function handleAdsStart(req, env, tg, body) {
  const cfg = await getConfig(env);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (user.banned) return err("banned", 403, { reason: user.banReason });
  rollDaily(user, cfg);

  if (!cfg.ads.openAdEnabled && body.purpose === "open") return err("provider_disabled", 400);
  if (user.adsToday >= Number(cfg.ads.dailyAdLimit || 100)) return err("daily_limit", 400);

  const provider = cfg.ads.monetagZoneId ? "monetag" : "adsgram";
  const nonce = await createNonce(env, {
    tgId: tg.id,
    purpose: body.purpose || "earn",
    provider,
    completed: false,
  });

  await saveUser(env, user);
  return json({
    nonce,
    provider,
    blockId: cfg.ads.monetagZoneId || undefined,
    minWatch: Number(cfg.ads.minWatchSecs) || 5,
    clicksRequired: Number(cfg.ads.clicksRequired) || 0,
    cooldownKey: body.purpose || "earn",
  });
}

async function handleAdsComplete(req, env, tg, body) {
  const cfg = await getConfig(env);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);

  const n = await readNonce(env, body.nonce);
  if (!n || n.tgId !== tg.id) return err("ad_not_watched", 400);
  if (Date.now() - n.createdAt < Number(cfg.ads.minWatchSecs || 5) * 1000 - 500) return err("too_fast", 400);

  n.completed = true;
  await env.GD_KV.put("nonce:" + body.nonce, JSON.stringify(n), { expirationTtl: 600 });

  user.adsToday += 1;
  user.adsTotal += 1;
  user.adCounters[n.provider] = (user.adCounters[n.provider] || 0) + 1;

  let reward = 0;
  const rewardPurposes = ["earn", "monetag"];
  if (rewardPurposes.includes(n.purpose)) {
    reward = Number(cfg.economy.adReward) || 0;
    user.balance += reward;
  }
  await saveUser(env, user);
  await maybeCreditReferral(env, cfg, user);

  return json({ balance: user.balance, reward, adsToday: user.adsToday, adsTotal: user.adsTotal });
}

const GAME_IDS = ["catch", "merge", "flappy", "whack"];
const GAME_CAP_KEY = { catch: "maxRewardCatch", merge: "maxRewardMerge", flappy: "maxRewardFlappy", whack: "maxRewardWhack" };

async function handleGamesStart(req, env, tg, body) {
  const cfg = await getConfig(env);
  const game = body.game;
  if (!GAME_IDS.includes(game)) return err("not_ready", 400);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (user.banned) return err("banned", 403, { reason: user.banReason });
  rollDaily(user, cfg);

  if (user.pendingClaim) return err("pending_claim", 400, { pending: user.pendingClaim });

  const per = Number(cfg.games.dailyPlaysPerGame) || 3;
  const used = per - (user.playsLeft[game] ?? per);
  const left = user.playsLeft[game] ?? per;
  if (left <= 0) return err("game_limit", 400);

  user.playsLeft[game] = left - 1;
  await saveUser(env, user);

  const nonce = await createNonce(env, { tgId: tg.id, purpose: "game", game, completed: false }, 1800);
  return json({ nonce, playsLeft: user.playsLeft[game] });
}

async function handleGamesFinish(req, env, tg, body) {
  const cfg = await getConfig(env);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);

  const n = await readNonce(env, body.nonce);
  if (!n || n.tgId !== tg.id || n.purpose !== "game") return err("not_ready", 400);

  const score = Math.max(0, Math.floor(Number(body.score) || 0));
  const cap = Number(cfg.games[GAME_CAP_KEY[n.game]] || 100);
  // simple, tunable scaling: 1 point of score -> 1 GD, capped per round
  const reward = Math.min(score, cap);

  const sessionId = nonceId();
  user.pendingClaim = { sessionId, game: n.game, reward };
  await saveUser(env, user);

  await env.GD_KV.put(
    "nonce:session:" + sessionId,
    JSON.stringify({ tgId: tg.id, game: n.game, reward, claimed: false }),
    { expirationTtl: 3600 }
  );
  await deleteNonce(env, body.nonce);

  return json({ sessionId, reward });
}

async function handleGamesClaim(req, env, tg, body) {
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (!user.pendingClaim || user.pendingClaim.sessionId !== body.sessionId) return err("no_pending_claim", 400);

  const sess = await env.GD_KV.get("nonce:session:" + body.sessionId, "json");
  if (!sess || sess.tgId !== tg.id || sess.claimed) return err("no_pending_claim", 400);

  if (!body.adNonce) return err("ad_required", 400);
  const n = await readNonce(env, body.adNonce);
  if (!n || n.tgId !== tg.id || n.purpose !== "game" || !n.completed) return err("ad_not_verified", 400);
  await deleteNonce(env, body.adNonce);

  sess.claimed = true;
  await env.GD_KV.put("nonce:session:" + body.sessionId, JSON.stringify(sess), { expirationTtl: 3600 });

  user.balance += sess.reward;
  user.pendingClaim = null;
  await saveUser(env, user);

  return json({ balance: user.balance, reward: sess.reward });
}

async function handleWithdraw(req, env, tg, body) {
  const cfg = await getConfig(env);
  const user = await getUser(env, tg.id);
  if (!user) return err("not_ready", 400);
  if (user.banned) return err("banned", 403, { reason: user.banReason });
  if (!cfg.withdraw.enabled) return err("withdrawals_disabled", 400);

  if (Date.now() < Number(user.withdrawNextAt || 0)) return err("withdraw_cooldown", 400);

  const method = body.method === "gram" ? "gram" : "ton";
  const wallet = String(body.wallet || "").trim();
  if (!wallet || wallet.length < 4) return err("bad_address", 400);

  const amount = Math.floor(Number(body.amount) || 0);
  const gdPerUsd = Number(cfg.economy.gdPerUsd) || 1;
  const minGd = Number(cfg.withdraw.minWithdrawUsd) * gdPerUsd;
  if (amount < minGd) return err("below_min", 400);
  if (amount > user.balance) return err("insufficient_balance", 400);

  const activeRefs = user.activeRefs || 0;
  if (user.adsTotal < Number(cfg.withdraw.unlockAds) || activeRefs < Number(cfg.withdraw.unlockRefs)) {
    return err("locked", 400);
  }

  user.balance -= amount;
  user.withdrawNextAt = Date.now() + Number(cfg.withdraw.cooldownHours || 24) * 3600 * 1000;
  if (method === "ton") user.walletTon = wallet;
  else user.walletUsdt = wallet;

  const request = {
    id: nonceId(),
    tgId: tg.id,
    method,
    wallet,
    amount,
    status: "pending",
    createdAt: Date.now(),
  };
  user.withdrawals.unshift(request);
  await saveUser(env, user);

  const all = (await env.GD_KV.get("withdrawals", "json")) || [];
  all.unshift(request);
  await env.GD_KV.put("withdrawals", JSON.stringify(all.slice(0, 2000)));

  return json({ balance: user.balance, request });
}

/* ---------------- admin endpoints ---------------- */

function requireAdmin(req, env) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return env.ADMIN_SECRET && token === env.ADMIN_SECRET;
}

async function handleAdmin(req, env, url) {
  if (!requireAdmin(req, env)) return err("unauthorized", 401);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","admin",...]
  const sub = parts[2];

  if (sub === "config") {
    if (req.method === "GET") return json(await getConfig(env));
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const current = await getConfig(env);
      const merged = {
        app: { ...current.app, ...body.app },
        maintenance: body.maintenance ?? current.maintenance,
        economy: { ...current.economy, ...body.economy },
        ads: { ...current.ads, ...body.ads },
        games: { ...current.games, ...body.games },
        withdraw: { ...current.withdraw, ...body.withdraw },
      };
      await env.GD_KV.put("config", JSON.stringify(merged));
      return json(merged);
    }
  }

  if (sub === "tasks") {
    if (req.method === "GET") return json(await getTasks(env));
    if (req.method === "POST") {
      const body = await req.json().catch(() => ([]));
      await env.GD_KV.put("tasks", JSON.stringify(body));
      return json(body);
    }
  }

  if (sub === "promo" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const code = String(body.code || randCode(8)).toUpperCase();
    const promo = {
      code,
      reward: Number(body.reward) || 0,
      maxUses: Number(body.maxUses) || 0,
      expiresAt: body.expiresAt ? Number(body.expiresAt) : 0,
      redeemedBy: [],
    };
    await env.GD_KV.put("promo:" + code, JSON.stringify(promo));
    return json(promo);
  }

  if (sub === "withdrawals" && req.method === "GET") {
    return json((await env.GD_KV.get("withdrawals", "json")) || []);
  }

  if (sub === "user" && parts[3]) {
    const tgId = parts[3];
    if (req.method === "GET") {
      const u = await getUser(env, tgId);
      if (!u) return err("not_found", 404);
      return json(u);
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const u = await getUser(env, tgId);
      if (!u) return err("not_found", 404);
      Object.assign(u, body);
      await saveUser(env, u);
      return json(u);
    }
  }

  return err("not_found", 404);
}

/* ---------------- router ---------------- */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return json({}, 204);

    if (!url.pathname.startsWith("/api/")) {
      // Non-API requests fall through to the static assets binding
      // configured in wrangler.toml (see [assets] / [site]).
      if (env.ASSETS) return env.ASSETS.fetch(req);
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      try {
        return await handleAdmin(req, env, url);
      } catch (e) {
        return err("server_error", 500, { message: String(e && e.message || e) });
      }
    }

    // everything else under /api requires a verified Telegram user
    const tg = await authenticate(req, env);
    if (!tg) return err("invalid_init_data", 401);

    let body = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));

    try {
      if (url.pathname === "/api/me" && req.method === "GET") return await handleMe(req, env, tg, url);
      if (url.pathname === "/api/channel/check" && req.method === "POST") return await handleChannelCheck(req, env, tg);
      if (url.pathname === "/api/bonus/claim" && req.method === "POST") return await handleBonusClaim(req, env, tg, body);
      if (url.pathname === "/api/promo/redeem" && req.method === "POST") return await handlePromoRedeem(req, env, tg, body);
      if (url.pathname === "/api/ads/start" && req.method === "POST") return await handleAdsStart(req, env, tg, body);
      if (url.pathname === "/api/ads/complete" && req.method === "POST") return await handleAdsComplete(req, env, tg, body);
      if (url.pathname === "/api/games/start" && req.method === "POST") return await handleGamesStart(req, env, tg, body);
      if (url.pathname === "/api/games/finish" && req.method === "POST") return await handleGamesFinish(req, env, tg, body);
      if (url.pathname === "/api/games/claim" && req.method === "POST") return await handleGamesClaim(req, env, tg, body);
      if (url.pathname === "/api/withdraw" && req.method === "POST") return await handleWithdraw(req, env, tg, body);

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(start|verify|claim)$/);
      if (taskMatch && req.method === "POST") {
        const [, taskId, action] = taskMatch;
        if (action === "start") return await handleTaskStart(req, env, tg, taskId);
        if (action === "verify") return await handleTaskVerify(req, env, tg, taskId);
        if (action === "claim") return await handleTaskClaim(req, env, tg, taskId, body);
      }

      return err("not_found", 404);
    } catch (e) {
      return err("server_error", 500, { message: String((e && e.message) || e) });
    }
  },
};
