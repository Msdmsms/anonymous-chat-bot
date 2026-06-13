const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

// ─── Config ──────────────────────────────────────────────────────
const ADMIN_USERNAMES = ["Mojeao", "Abslnf"];
const adminIds = new Set();
const sponsorChannels = [];
const REFERRAL_COINS = 20;
const FREE_DAILY_COINS = 3;
const GENDER_FILTER_COST = 2;
const MAX_WARNINGS = 5;
const MAX_LOG_MSG = 50;   // messages stored per chat
const MAX_CHAT_LOGS = 50; // recent chats kept

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── Store ────────────────────────────────────────────────────────
const users    = new Map();
const sessions = new Map();
const waiting  = new Map();
const blocked  = new Map();
const chatCodes = new Map();
const refCodes  = new Map();
const adminBroadcast = new Set();
const reports  = [];
const warnings = new Map(); // userId → count
const chatLogs = []; // [{id, u1, u2, startTs, endTs, msgs:[{from,text,ts}]}]
let chatLogIdCounter = 1;

function getUser(id, firstName, username) {
  if (!users.has(id)) users.set(id, { firstName: firstName || "", username: username || null, coins: 5, lastFreeCoins: 0, banned: false });
  const u = users.get(id);
  if (firstName) u.firstName = firstName;
  if (username !== undefined) u.username = username;
  return u;
}
function sess(id) {
  if (!sessions.has(id)) sessions.set(id, { step: "idle", partnerId: null, disconnectPartnerId: null, chatLogId: null });
  return sessions.get(id);
}
function isAdmin(msg) {
  const u = msg.from && msg.from.username;
  if (u && ADMIN_USERNAMES.includes(u)) { adminIds.add(msg.chat.id); return true; }
  return adminIds.has(msg.chat.id);
}
function isBlocked(a, b) { const s = blocked.get(a); return s && s.has(b); }
function blockUser(a, b) { if (!blocked.has(a)) blocked.set(a, new Set()); blocked.get(a).add(b); }

// ─── Warning system ───────────────────────────────────────────────
function getWarnings(id) { return warnings.get(id) || 0; }
async function giveWarning(adminId, targetId, reason) {
  const count = getWarnings(targetId) + 1;
  warnings.set(targetId, count);
  const u = users.get(targetId);
  const name = u ? (u.username ? `@${u.username}` : u.firstName) : String(targetId);
  if (count >= MAX_WARNINGS) {
    if (u) u.banned = true;
    doDisconnect(targetId, false);
    send(targetId,
      `🚫 <b>حساب شما مسدود شد!</b>\n\nشما ${MAX_WARNINGS} اخطار دریافت کردید و حسابتان مسدود شده است.\nدلیل آخرین اخطار: <b>${reason || "تخلف"}</b>`
    );
    for (const aId of adminIds) {
      if (aId !== adminId) send(aId, `🚫 کاربر ${name} (<code>${targetId}</code>) بعد از ${MAX_WARNINGS} اخطار <b>بن شد</b>.`);
    }
    send(adminId, `🚫 کاربر ${name} (<code>${targetId}</code>) به ${MAX_WARNINGS} اخطار رسید و <b>بن شد</b>.`);
  } else {
    const remaining = MAX_WARNINGS - count;
    send(targetId,
      `⚠️ <b>اخطار ${count} از ${MAX_WARNINGS}</b>\n\nشما از طرف مدیریت اخطار دریافت کردید.\n📋 دلیل: <b>${reason || "رفتار نامناسب"}</b>\n\n⚠️ ${remaining} اخطار دیگر حساب شما مسدود خواهد شد.`
    );
    send(adminId, `✅ اخطار ${count}/${MAX_WARNINGS} به ${name} (<code>${targetId}</code>) داده شد.`);
  }
}

// ─── Chat logging ─────────────────────────────────────────────────
function startChatLog(u1, u2) {
  const log = { id: chatLogIdCounter++, u1, u2, startTs: Date.now(), endTs: null, msgs: [] };
  chatLogs.push(log);
  if (chatLogs.length > MAX_CHAT_LOGS) chatLogs.shift();
  sess(u1).chatLogId = log.id;
  sess(u2).chatLogId = log.id;
  return log;
}
function logMessage(userId, text, type) {
  const s = sess(userId);
  const log = chatLogs.find(l => l.id === s.chatLogId);
  if (!log) return;
  if (log.msgs.length >= MAX_LOG_MSG) log.msgs.shift();
  log.msgs.push({ from: userId, text: text || `[${type || "media"}]`, ts: Date.now() });
}
function endChatLog(u1, u2) {
  const s = sess(u1);
  const log = chatLogs.find(l => l.id === s.chatLogId);
  if (log && !log.endTs) log.endTs = Date.now();
}

// ─── Random codes ─────────────────────────────────────────────────
function genCode() { return Math.random().toString(36).slice(2, 10); }
function getChatCode(userId) {
  for (const [c, id] of chatCodes) if (id === userId) return c;
  const code = "sec-" + genCode(); chatCodes.set(code, userId); return code;
}
function getRefCode(userId) {
  for (const [c, id] of refCodes) if (id === userId) return c;
  const code = "ref-" + genCode(); refCodes.set(code, userId); return code;
}

// ─── Keyboards ───────────────────────────────────────────────────
function kb(keys, oneTime) {
  return { keyboard: keys.map(r => r.map(t => ({ text: t }))), resize_keyboard: true, one_time_keyboard: !!oneTime };
}
const KB = {
  main:    kb([["🔗 به یه ناشناس وصلم کن!"],["❤️ به مخاطب خاصم وصلم کن!"],["👥 پیام ناشناس به گروه","🔗 لینک ناشناس من"],["🏆 افزایش امتیاز","راهنما"]]),
  prefer:  kb([["👦 پسر باشه","👧 دختر باشه"],["مهم نیست"]], true),
  waiting: kb([["❌ لغو جستجو"]]),
  chat:    kb([["قطع مکالمه"]]),
  confirmDisconnect: kb([["آره گپ رو قطع کن","بیخیال"]], true),
  confirmBlock:      kb([["آره بلاکش کن","بیخیال، بعداً هم وصل شم"]], true),
  blockReason: kb([["جنسیتش اشتباه بود","بی ادب بود"],["باهاش حال نکردم","تبلیغ فرستاد"],["بیخیال، بعداً هم وصل شم"]], true),
  cancel:  kb([["❌ انصراف"]], true),
  points:  kb([["اعتبار رایگان"],["🔙 برگشت"]]),
  admin:   kb([
    ["📢 پیام همگانی"],
    ["➕ اضافه اسپانسر","🗑 حذف اسپانسر"],
    ["📋 لیست اسپانسرها","📊 آمار"],
    ["🚨 گزارش‌ها","💬 چت‌ها"],
    ["🔙 برگشت"],
  ]),
};

function send(id, text, keyboard, extra) {
  return bot.sendMessage(id, text, Object.assign({ reply_markup: keyboard, parse_mode: "HTML" }, extra || {}))
    .catch(e => console.error("send err:", e.message));
}

// ─── Force join ───────────────────────────────────────────────────
async function getMissing(userId) {
  if (!sponsorChannels.length) return [];
  const out = [];
  for (const ch of sponsorChannels) {
    try { const m = await bot.getChatMember(ch.username, userId); if (!["member","administrator","creator"].includes(m.status)) out.push(ch); }
    catch { out.push(ch); }
  }
  return out;
}
async function requireJoin(userId) {
  const missing = await getMissing(userId);
  if (!missing.length) return true;
  const btns = missing.map(ch => [{ text: ch.label, url: `https://t.me/${ch.username.replace("@","")}` }]);
  btns.push([{ text: "✅ عضو شدم", callback_data: "check_join" }]);
  bot.sendMessage(userId, "⚠️ برای استفاده از ربات باید عضو کانال‌های زیر بشی:\n\nبعد از جوین دکمه «✅ عضو شدم» رو بزن.", { reply_markup: { inline_keyboard: btns } });
  return false;
}

// ─── Search & disconnect ──────────────────────────────────────────
function doSearch(userId, prefer) {
  const s = sess(userId);
  const u = users.get(userId);
  if (prefer !== "any") {
    const coins = u ? u.coins : 0;
    if (coins < GENDER_FILTER_COST) {
      send(userId, `⚠️ <b>سکه کافی نداری!</b>\n\nجستجو با فیلتر جنسیت <b>${GENDER_FILTER_COST} سکه</b> هزینه داره.\nموجودی: <b>${coins} سکه</b>`, KB.main);
      s.step = "idle"; return;
    }
    if (u) u.coins -= GENDER_FILTER_COST;
    send(userId, `🪙 <b>${GENDER_FILTER_COST} سکه</b> کم شد. موجودی: <b>${u ? u.coins : 0} سکه</b>`);
  }
  for (const [cId, cPrefer] of waiting.entries()) {
    if (cId === userId) continue;
    if (isBlocked(userId, cId) || isBlocked(cId, userId)) continue;
    if (prefer === "any" || cPrefer === "any" || prefer === cPrefer) {
      waiting.delete(cId);
      s.step = "in_chat"; s.partnerId = cId;
      const cs = sess(cId); cs.step = "in_chat"; cs.partnerId = userId;
      startChatLog(userId, cId);
      const msg = "یافتم و وصلتون کردم 🤜 با مخاطب ناشناست حرف بزن!";
      send(userId, msg, KB.chat);
      send(cId, msg, KB.chat);
      return;
    }
  }
  waiting.set(userId, prefer); s.step = "waiting";
  send(userId, `🔍 <b>در حال اتصال ...</b>\n\nاگه تا حداکثر یک دقیقه آینده پیامی ارسال نشد دوباره تلاش کنید`, KB.waiting);
}

function doDisconnect(userId, notifyPartner) {
  const s = sess(userId);
  const pId = s.partnerId;
  waiting.delete(userId);
  if (pId) endChatLog(userId, pId);
  s.step = "idle"; s.partnerId = null; s.disconnectPartnerId = null; s.chatLogId = null;
  if (pId) {
    const ps = sess(pId);
    ps.partnerId = null; ps.chatLogId = null;
    if (notifyPartner !== false) {
      ps.step = "confirm_block";
      ps.disconnectPartnerId = userId;
      send(pId, "این گپ بسته شد!\n\nنیاز داری این مخاطب رو بلاک کنم که دیگه بهت متصل نشه؟", KB.confirmBlock);
    } else {
      ps.step = "idle"; ps.disconnectPartnerId = null;
    }
  }
  return pId;
}

// ─── Callbacks ───────────────────────────────────────────────────
bot.on("callback_query", async q => {
  const userId = q.from.id;
  const data = q.data || "";
  bot.answerCallbackQuery(q.id).catch(() => {});

  if (data === "check_join") {
    const miss = await getMissing(userId);
    if (!miss.length) {
      bot.deleteMessage(userId, q.message.message_id).catch(() => {});
      send(userId, "✅ عضویت تأیید شد! از منوی زیر انتخاب کن 👇", KB.main);
    } else {
      bot.answerCallbackQuery(q.id, { text: "هنوز همه کانال‌ها رو جوین نکردی!", show_alert: true });
    }
    return;
  }

  if (data.startsWith("remove_sp:")) {
    if (!adminIds.has(userId)) return;
    const i = parseInt(data.split(":")[1], 10);
    if (!isNaN(i) && sponsorChannels[i]) {
      const r = sponsorChannels.splice(i, 1)[0];
      bot.editMessageText(`✅ «${r.label}» حذف شد.`, { chat_id: userId, message_id: q.message.message_id }).catch(() => {});
    }
    return;
  }

  // Admin: ban from report/chat
  if (data.startsWith("admin_ban:")) {
    if (!adminIds.has(userId)) return;
    const tId = parseInt(data.split(":")[1], 10);
    const u = users.get(tId);
    if (u) {
      u.banned = true; doDisconnect(tId, false);
      for (const r of reports) if (r.reportedId === tId) r.banned = true;
      bot.editMessageText(`✅ کاربر <b>${tId}</b> بن شد.`, { chat_id: userId, message_id: q.message.message_id, parse_mode: "HTML" }).catch(() => {});
    }
    return;
  }

  // Admin: warn from chat view
  if (data.startsWith("admin_warn:")) {
    if (!adminIds.has(userId)) return;
    const parts = data.split(":");
    const tId = parseInt(parts[1], 10);
    const reason = parts.slice(2).join(":") || "رفتار نامناسب";
    await giveWarning(userId, tId, reason);
    bot.editMessageText(`⚠️ اخطار به ${tId} داده شد (${getWarnings(tId)}/${MAX_WARNINGS})`, { chat_id: userId, message_id: q.message.message_id }).catch(() => {});
    return;
  }

  // Admin: view chat log
  if (data.startsWith("chat_view:")) {
    if (!adminIds.has(userId)) return;
    const logId = parseInt(data.split(":")[1], 10);
    const log = chatLogs.find(l => l.id === logId);
    if (!log) { send(userId, "⚠️ چت پیدا نشد."); return; }
    const u1 = users.get(log.u1); const u2 = users.get(log.u2);
    const n1 = u1 ? (u1.username ? `@${u1.username}` : u1.firstName) : `#${log.u1}`;
    const n2 = u2 ? (u2.username ? `@${u2.username}` : u2.firstName) : `#${log.u2}`;
    const status = log.endTs ? `پایان یافته` : `🟢 فعال`;
    let text = `💬 <b>چت #${log.id}</b>\n👤 کاربر A: ${n1} (<code>${log.u1}</code>)\n👤 کاربر B: ${n2} (<code>${log.u2}</code>)\n📌 وضعیت: ${status}\n\n`;
    if (!log.msgs.length) {
      text += "📭 پیامی ثبت نشده.";
    } else {
      for (const m of log.msgs.slice(-30)) {
        const sender = m.from === log.u1 ? "A" : "B";
        const time = new Date(m.ts).toLocaleTimeString("fa-IR");
        text += `[${time}] <b>${sender}:</b> ${m.text.slice(0, 200)}\n`;
      }
    }
    const wA = getWarnings(log.u1); const wB = getWarnings(log.u2);
    send(userId, text, undefined, {
      reply_markup: { inline_keyboard: [
        [
          { text: `⚠️ اخطار به A (${wA}/${MAX_WARNINGS})`, callback_data: `admin_warn:${log.u1}:رفتار نامناسب` },
          { text: `⚠️ اخطار به B (${wB}/${MAX_WARNINGS})`, callback_data: `admin_warn:${log.u2}:رفتار نامناسب` },
        ],
        [
          { text: `🚫 بن A`, callback_data: `admin_ban:${log.u1}` },
          { text: `🚫 بن B`, callback_data: `admin_ban:${log.u2}` },
        ],
      ]}
    });
    return;
  }

  // راهنما
  const helpAnswers = {
    what: `👈 <b>برنامه ناشناس</b>\n\n🔷 هر وقت حوصلت سر رفت میتونی به یک نفر وصل بشی و به صورت ناشناس باهاش چت کنی 😀\n\n🔷 میتونی به دوستات اجازه بدی هر حرف یا انتقادی که تو دلشون مونده رو به صورت ناشناس بهت بگن!\n\n🔷 میتونی به گروه‌هایی که توشون هستی پیام ناشناس بفرستی!\n\n🔷 جذاب‌تر از همه: میتونی به مخاطب خاصت به صورت ناشناس پیام بفرستی 👌`,
    receive: `👈 <b>چطوری پیام ناشناس دریافت کنم؟</b>\n\nکافیه /link رو بزنی. لینکت رو برای دوستات بفرستی تا بتونن ناشناس بهت پیام بدن.`,
    specific: `👈 <b>چطوری به مخاطب خاصم وصل بشم؟</b>\n\nباید @Username یا یه پیام از اون شخص فوروارد کنی!\n\nخیلی راحت بدون اینکه بفهمه کی هستی پیام ناشناس بفرستی 😎`,
    random: `👈 <b>چطوری به یه ناشناس تصادفی وصل شیم؟</b>\n\nروی دکمه «به یه ناشناس وصلم کن» کلیک کن!`,
  };
  if (data.startsWith("help:")) {
    const topic = data.slice(5);
    const backBtn = { inline_keyboard: [[{ text: "🔙 بازگشت به صفحه راهنما", callback_data: "help:back" }]] };
    if (topic === "back") {
      bot.editMessageText(`راهنما 🔍\n\nمن از اینجام که کمکت کنم 😀\nبرای دریافت راهنمایی در مورد هر موضوع، کافیه دکمه مورد نظر رو لمس کنی 👇`, {
        chat_id: userId, message_id: q.message.message_id, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "👈 این ربات چیه؟", callback_data: "help:what" }],
          [{ text: "👈 چطوری پیام ناشناس دریافت کنم؟", callback_data: "help:receive" }],
          [{ text: "👈 چطوری به مخاطب خاصم وصل بشم؟", callback_data: "help:specific" }],
          [{ text: "👈 چطوری به یه ناشناس تصادفی وصل شیم؟", callback_data: "help:random" }],
        ]}
      }).catch(() => {});
    } else if (helpAnswers[topic]) {
      bot.editMessageText(helpAnswers[topic], { chat_id: userId, message_id: q.message.message_id, parse_mode: "HTML", reply_markup: backBtn }).catch(() => {});
    }
    return;
  }
});

// ─── /start ───────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.chat.id;
  const firstName = (msg.from && msg.from.first_name) || "کاربر";
  const username = (msg.from && msg.from.username) || null;
  if (username && ADMIN_USERNAMES.includes(username)) adminIds.add(userId);
  const user = getUser(userId, firstName, username);
  if (user.banned) { send(userId, "⛔ حساب شما مسدود شده است."); return; }
  const deep = (match && match[1]) || "";

  if (deep.startsWith("ref-")) {
    const rId = refCodes.get(deep);
    if (rId && rId !== userId && !user._refDone) {
      user._refDone = true;
      const ref = users.get(rId);
      if (ref) { ref.coins += REFERRAL_COINS; send(rId, `🎉 یه نفر با لینک دعوت تو وارد ربات شد!\n\n👈 <b>+${REFERRAL_COINS} سکه</b>\nموجودی: <b>${ref.coins} سکه</b>`); }
    }
  }
  if (deep.startsWith("sec-")) {
    const tId = chatCodes.get(deep);
    if (tId && tId !== userId) {
      if (!(await requireJoin(userId))) return;
      const ts = sess(tId);
      if (ts.step === "idle") {
        const s = sess(userId); s.step = "in_chat"; s.partnerId = tId;
        ts.step = "in_chat"; ts.partnerId = userId;
        startChatLog(userId, tId);
        send(userId, "یافتم و وصلتون کردم 🤜 با مخاطب ناشناست حرف بزن!", KB.chat);
        send(tId, "🔔 یه نفر از طریق لینک شخصی‌ات اومد!\n\nیافتم و وصلتون کردم 🤜 باهاش حرف بزن!", KB.chat);
        return;
      }
      send(userId, "⚠️ این کاربر الان در دسترس نیست.", KB.main); return;
    }
  }
  if (!(await requireJoin(userId))) return;
  sess(userId).step = "idle";
  send(userId, "حله!\nچه کاری برات انجام بدم؟", KB.main);
});

// ─── /link /banner ───────────────────────────────────────────────
bot.onText(/\/link/, async (msg) => {
  const userId = msg.chat.id;
  getUser(userId, msg.from && msg.from.first_name, msg.from && msg.from.username);
  const me = await bot.getMe(); const code = getChatCode(userId);
  const link = `https://t.me/${me.username}?start=${code}`;
  await send(userId, `سلام 🖐 هستم\n\nلینک زیر رو لمس کن و هر حرفی که تو دلت هست یا از روم داری رو با خیال راحت بنویس و بفرست. بدون اینکه از اسمت باخبر بشم راحتی ناشناس بهم پیام بده! خودمم می‌تونی امتحان کنی و از بقیه ناشناس بهت پیام بفرستن، حرفای خیلی جالبی می‌شنوی! 😉\n\n☝️☝️\n${link}\n\nTelegram\n\n<b>چت ناشناس</b>\nامن و معتبر ترین ربات ناشناس تلگرام\nنیمه گمشدت منتظره بهش پیام بدی :)`);
  send(userId, `☝️ پیام بالا رو به دوستات و گروههایی که می‌شناسی فوروارد کن.\n\nاینستاگرامی داری؟ لینک بالارو بزار بیوت پس ;)`, KB.main);
});
bot.onText(/\/banner/, async (msg) => {
  const userId = msg.chat.id;
  getUser(userId, msg.from && msg.from.first_name, msg.from && msg.from.username);
  const me = await bot.getMe(); const refCode = getRefCode(userId);
  send(userId, `یا این برنامه میتونی هر وقت بخوای به صورت تصادفی به یک نفر وصل بشی و کاملاً ناشناس گپ بزنی\n\n👇 شروع کن\nhttps://t.me/${me.username}?start=${refCode}`, KB.main);
});

// ─── /admin commands ──────────────────────────────────────────────
bot.onText(/\/admin/, (msg) => { if (!isAdmin(msg)) return; send(msg.chat.id, "👑 <b>پنل ادمین</b>", KB.admin); });
bot.onText(/\/ban (\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const tId = parseInt(match[1], 10); const u = users.get(tId);
  if (u) { u.banned = true; doDisconnect(tId, false); send(msg.chat.id, `✅ کاربر ${tId} بن شد.`); }
  else send(msg.chat.id, "❌ کاربر پیدا نشد.");
});
bot.onText(/\/unban (\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const tId = parseInt(match[1], 10); const u = users.get(tId);
  if (u) { u.banned = false; send(msg.chat.id, `✅ کاربر ${tId} آنبن شد.`); }
  else send(msg.chat.id, "❌ کاربر پیدا نشد.");
});
bot.onText(/\/warn (\d+)(?:\s+(.+))?/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const tId = parseInt(match[1], 10); const reason = match[2] || "رفتار نامناسب";
  const u = users.get(tId);
  if (!u) { send(msg.chat.id, "❌ کاربر پیدا نشد."); return; }
  await giveWarning(msg.chat.id, tId, reason);
});
bot.onText(/\/warnings (\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const tId = parseInt(match[1], 10);
  send(msg.chat.id, `⚠️ کاربر ${tId}: <b>${getWarnings(tId)}/${MAX_WARNINGS}</b> اخطار`);
});
bot.onText(/\/coins (\d+) (\d+)/, (msg, match) => {
  if (!isAdmin(msg)) return;
  const tId = parseInt(match[1], 10); const n = parseInt(match[2], 10);
  const u = users.get(tId);
  if (u) { u.coins += n; send(msg.chat.id, `✅ ${n} سکه به ${tId}. موجودی: ${u.coins}`); }
  else send(msg.chat.id, "❌ کاربر پیدا نشد.");
});

// ─── Messages ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const userId = msg.chat.id;
  const text = msg.text || "";
  const username = (msg.from && msg.from.username) || null;
  const firstName = (msg.from && msg.from.first_name) || "کاربر";
  if (username && ADMIN_USERNAMES.includes(username)) adminIds.add(userId);
  if (text.startsWith("/")) return;
  const user = getUser(userId, firstName, username);
  if (user.banned) return;
  const s = sess(userId);

  // ── Admin broadcast ───────────────────────────────────────────
  if (adminBroadcast.has(userId)) {
    adminBroadcast.delete(userId);
    if (text === "❌ انصراف") { send(userId, "❌ لغو.", KB.admin); return; }
    let sent = 0, failed = 0;
    for (const uid of users.keys()) {
      if (uid === userId) continue;
      try {
        if (msg.text) await bot.sendMessage(uid, msg.text, { parse_mode: "HTML" });
        else await bot.copyMessage(uid, userId, msg.message_id);
        sent++; await new Promise(r => setTimeout(r, 35));
      } catch { failed++; }
    }
    send(userId, `✅ ارسال شد!\n📤 موفق: <b>${sent}</b>\n❌ ناموفق: <b>${failed}</b>`, KB.admin);
    return;
  }

  // ── Admin add sponsor ─────────────────────────────────────────
  if (s.step === "admin_add_sponsor") {
    if (text === "❌ انصراف") { s.step = "idle"; send(userId, "❌ لغو.", KB.admin); return; }
    const ch = text.startsWith("@") ? text.trim() : "@" + text.trim();
    const label = `اسپانسر ${sponsorChannels.length + 1}`;
    sponsorChannels.push({ username: ch, label });
    s.step = "idle"; send(userId, `✅ اسپانسر اضافه شد!\n📌 ${ch}\n🏷 ${label}`, KB.admin); return;
  }

  // ── Admin panel ───────────────────────────────────────────────
  if (isAdmin(msg)) {
    if (text === "📢 پیام همگانی") { adminBroadcast.add(userId); send(userId, "📢 پیامت رو بفرست:", KB.cancel); return; }
    if (text === "➕ اضافه اسپانسر") { s.step = "admin_add_sponsor"; send(userId, "📌 یوزرنیم کانال رو بفرست:", KB.cancel); return; }
    if (text === "🗑 حذف اسپانسر") {
      if (!sponsorChannels.length) { send(userId, "⚠️ هیچ اسپانسری نیست.", KB.admin); return; }
      const inline = sponsorChannels.map((ch, i) => [{ text: `🗑 ${ch.label} (${ch.username})`, callback_data: `remove_sp:${i}` }]);
      bot.sendMessage(userId, "کدوم حذف بشه؟", { reply_markup: { inline_keyboard: inline } }); return;
    }
    if (text === "📋 لیست اسپانسرها") {
      if (!sponsorChannels.length) { send(userId, "⚠️ خالی.", KB.admin); return; }
      send(userId, `📋 <b>لیست:</b>\n\n${sponsorChannels.map((c,i)=>`${i+1}. ${c.label} — ${c.username}`).join("\n")}`, KB.admin); return;
    }
    if (text === "📊 آمار") {
      const active = Math.floor([...sessions.values()].filter(x=>x.step==="in_chat").length/2);
      send(userId, `📊 <b>آمار</b>\n\n👥 کاربران: <b>${users.size}</b>\n💬 چت فعال: <b>${active}</b>\n⏳ صف: <b>${waiting.size}</b>\n📌 اسپانسرها: <b>${sponsorChannels.length}</b>\n🚨 گزارش‌ها: <b>${reports.length}</b>\n📝 لاگ چت‌ها: <b>${chatLogs.length}</b>`, KB.admin); return;
    }
    if (text === "🚨 گزارش‌ها") {
      if (!reports.length) { send(userId, "📭 هیچ گزارشی ثبت نشده.", KB.admin); return; }
      const last10 = reports.slice(-10).reverse();
      for (const r of last10) {
        const ru = users.get(r.reporterId); const tu = users.get(r.reportedId);
        const rName = ru ? (ru.username ? `@${ru.username}` : ru.firstName) : r.reporterId;
        const tName = tu ? (tu.username ? `@${tu.username}` : tu.firstName) : r.reportedId;
        const status = r.banned ? "✅ بن شده" : "⚠️ فعال";
        const w = getWarnings(r.reportedId);
        const inline = r.banned
          ? [[{ text: "✅ قبلاً بن شده", callback_data: "noop" }]]
          : [[{ text: `⚠️ اخطار (${w}/${MAX_WARNINGS})`, callback_data: `admin_warn:${r.reportedId}:${r.reason}` }, { text: `🚫 بن`, callback_data: `admin_ban:${r.reportedId}` }]];
        await bot.sendMessage(userId,
          `🚨 <b>گزارش</b>\n\n👤 گزارش‌دهنده: ${rName} (<code>${r.reporterId}</code>)\n🎯 گزارش‌شده: ${tName} (<code>${r.reportedId}</code>)\n📋 دلیل: <b>${r.reason}</b>\n⚠️ اخطارها: <b>${w}/${MAX_WARNINGS}</b>\n📌 وضعیت: ${status}`,
          { reply_markup: { inline_keyboard: inline }, parse_mode: "HTML" }
        ).catch(() => {});
        await new Promise(r => setTimeout(r, 100));
      }
      return;
    }
    if (text === "💬 چت‌ها") {
      if (!chatLogs.length) { send(userId, "📭 هیچ چتی ثبت نشده.", KB.admin); return; }
      const last10 = chatLogs.slice(-10).reverse();
      const inline = last10.map(log => {
        const u1 = users.get(log.u1); const u2 = users.get(log.u2);
        const n1 = u1 ? (u1.username ? `@${u1.username}` : u1.firstName) : `#${log.u1}`;
        const n2 = u2 ? (u2.username ? `@${u2.username}` : u2.firstName) : `#${log.u2}`;
        const status = log.endTs ? "🔴" : "🟢";
        return [{ text: `${status} #${log.id}: ${n1} ↔ ${n2} (${log.msgs.length} پیام)`, callback_data: `chat_view:${log.id}` }];
      });
      bot.sendMessage(userId, "💬 <b>چت‌های اخیر:</b>\n\n🟢 فعال | 🔴 پایان‌یافته", { reply_markup: { inline_keyboard: inline }, parse_mode: "HTML" });
      return;
    }
    if (text === "🔙 برگشت") { s.step = "idle"; send(userId, "از منوی زیر انتخاب کن 👇", KB.main); return; }
  }

  // ── search_prefer ─────────────────────────────────────────────
  if (s.step === "search_prefer") {
    if (text === "❌ انصراف") { s.step = "idle"; send(userId, "❌ لغو.", KB.main); return; }
    let prefer = "any";
    if (text === "👦 پسر باشه") prefer = "male";
    else if (text === "👧 دختر باشه") prefer = "female";
    else if (text === "مهم نیست") prefer = "any";
    else { send(userId, "از دکمه‌های زیر انتخاب کن 👇", KB.prefer); return; }
    s.step = "idle"; doSearch(userId, prefer); return;
  }

  // ── waiting ───────────────────────────────────────────────────
  if (s.step === "waiting") {
    if (text === "❌ لغو جستجو") { waiting.delete(userId); s.step = "idle"; send(userId, "❌ جستجو لغو شد.", KB.main); }
    else send(userId, "⏳ هنوز داری منتظری... اگه تا یک دقیقه پیامی نرسید دوباره تلاش کن.", KB.waiting);
    return;
  }

  // ── confirm_disconnect ────────────────────────────────────────
  if (s.step === "confirm_disconnect") {
    if (text === "بیخیال") { s.step = "in_chat"; s.disconnectPartnerId = null; send(userId, "👍 ادامه بده!", KB.chat); return; }
    if (text === "آره گپ رو قطع کن") {
      const pId = s.disconnectPartnerId || s.partnerId;
      doDisconnect(userId, true);
      s.disconnectPartnerId = pId; s.step = "confirm_block";
      send(userId, "این گپ بسته شد!\n\nنیاز داری این مخاطب رو بلاک کنم که دیگه بهت متصل نشه؟", KB.confirmBlock); return;
    }
    send(userId, "از دکمه‌های زیر انتخاب کن 👇", KB.confirmDisconnect); return;
  }

  // ── confirm_block ─────────────────────────────────────────────
  if (s.step === "confirm_block") {
    if (text === "بیخیال، بعداً هم وصل شم") { s.step = "idle"; s.disconnectPartnerId = null; send(userId, "حله!\nچه کاری برات انجام بدم؟", KB.main); return; }
    if (text === "آره بلاکش کن") { s.step = "block_reason"; send(userId, "چرا می‌خوای بلاکش کنی؟", KB.blockReason); return; }
    send(userId, "از دکمه‌های زیر انتخاب کن 👇", KB.confirmBlock); return;
  }

  // ── block_reason ──────────────────────────────────────────────
  if (s.step === "block_reason") {
    const validReasons = ["جنسیتش اشتباه بود","بی ادب بود","باهاش حال نکردم","تبلیغ فرستاد"];
    if (text === "بیخیال، بعداً هم وصل شم") { s.step = "idle"; s.disconnectPartnerId = null; send(userId, "حله!\nچه کاری برات انجام بدم؟", KB.main); return; }
    if (validReasons.includes(text)) {
      const tId = s.disconnectPartnerId;
      if (tId) {
        blockUser(userId, tId);
        const report = { id: reports.length+1, reporterId: userId, reportedId: tId, reason: text, ts: Date.now(), banned: false };
        reports.push(report);
        // Notify reported user
        send(tId, `⚠️ <b>پیام سیستم:</b>\n\nیک کاربر شما را گزارش داده است.\n📋 دلیل: <b>${text}</b>\n\nرفتار مناسب داشته باشید تا حسابتان مسدود نشود.`);
        // Notify admins
        const tu = users.get(tId);
        const tName = tu ? (tu.username ? `@${tu.username}` : tu.firstName) : String(tId);
        for (const aId of adminIds) {
          bot.sendMessage(aId,
            `🚨 <b>گزارش جدید #${report.id}</b>\n\n🎯 گزارش‌شده: ${tName} (<code>${tId}</code>)\n📋 دلیل: <b>${text}</b>\n⚠️ اخطارها: <b>${getWarnings(tId)}/${MAX_WARNINGS}</b>`,
            { reply_markup: { inline_keyboard: [[{ text: `⚠️ اخطار`, callback_data: `admin_warn:${tId}:${text}` }, { text: `🚫 بن`, callback_data: `admin_ban:${tId}` }]] }, parse_mode: "HTML" }
          ).catch(() => {});
        }
      }
      s.step = "idle"; s.disconnectPartnerId = null;
      send(userId, `✅ گزارش ثبت شد و بلاک انجام شد.\n\nحله!\nچه کاری برات انجام بدم؟`, KB.main); return;
    }
    send(userId, "از دکمه‌های زیر انتخاب کن 👇", KB.blockReason); return;
  }

  // ── connect_specific ──────────────────────────────────────────
  if (s.step === "connect_specific") {
    if (text === "❌ انصراف") { s.step = "idle"; send(userId, "❌ لغو.", KB.main); return; }
    let targetId = null;
    if (text.startsWith("@")) {
      const t = text.slice(1).toLowerCase();
      for (const [uid, u] of users.entries()) if (u.username && u.username.toLowerCase() === t) { targetId = uid; break; }
      if (!targetId) { send(userId, `❌ کاربر <b>${text}</b> در ربات پیدا نشد.\n\nیا یه پیام ازش فوروارد کن 👇`, KB.cancel); return; }
    }
    if (!targetId && msg.forward_from) targetId = msg.forward_from.id;
    if (!targetId) { send(userId, "⚠️ @Username بفرست یا یه پیام فوروارد کن:", KB.cancel); return; }
    if (targetId === userId) { send(userId, "❌ نمیتونی با خودت چت کنی!", KB.cancel); return; }
    const ts = sess(targetId);
    if (ts.step !== "idle") { s.step = "idle"; send(userId, "⚠️ این کاربر الان در دسترس نیست.", KB.main); return; }
    s.step = "in_chat"; s.partnerId = targetId; ts.step = "in_chat"; ts.partnerId = userId;
    startChatLog(userId, targetId);
    send(userId, "یافتم و وصلتون کردم 🤜 با مخاطب ناشناست حرف بزن!", KB.chat);
    send(targetId, "🔔 یه نفر ناشناس میخواد باهات چت کنه!\n\nیافتم و وصلتون کردم 🤜 باهاش حرف بزن!", KB.chat);
    return;
  }

  // ── in_chat ───────────────────────────────────────────────────
  if (s.step === "in_chat") {
    if (text === "قطع مکالمه") {
      s.disconnectPartnerId = s.partnerId; s.step = "confirm_disconnect";
      send(userId, "پیام سیستم:\n\nمطمئنی می‌خوای این گپ رو ببندی؟", KB.confirmDisconnect); return;
    }
    if (!s.partnerId) { s.step = "idle"; send(userId, "حله!\nچه کاری برات انجام بدم؟", KB.main); return; }
    // Log message
    const msgType = msg.photo ? "photo" : msg.video ? "video" : msg.sticker ? "sticker" : msg.voice ? "voice" : msg.document ? "doc" : msg.audio ? "audio" : "media";
    logMessage(userId, text || `[${msgType}]`, msgType);
    forwardMsg(msg, s.partnerId);
    return;
  }

  // ── main menu ─────────────────────────────────────────────────
  if (text === "🔗 به یه ناشناس وصلم کن!") {
    if (!(await requireJoin(userId))) return;
    s.step = "search_prefer"; send(userId, "برات مهمه مخاطبت پسر باشه یا دختر؟\nچت شانسی رایگان میباشد.", KB.prefer); return;
  }
  if (text === "❤️ به مخاطب خاصم وصلم کن!") {
    if (!(await requireJoin(userId))) return;
    s.step = "connect_specific";
    send(userId, `برای اینکه بتونم به مخاطب خاصت بطور ناشناس وصلت کنم، یکی از این ۲ کار رو انجام بده:\n\n👈 <b>راه اول :</b> @Username ← همون آی‌دی تلگرام اون شخص رو وارد ربات کن!\n\n👈 <b>راه دوم :</b> الان یه پیام متنی از اون شخص به این ربات فوروارد کن تا ببینیم عضو هست یا نه!`, KB.cancel); return;
  }
  if (text === "👥 پیام ناشناس به گروه") {
    bot.getMe().then(me => { const code = getChatCode(userId); send(userId, `👥 <b>پیام ناشناس به گروه</b>\n\nلینک زیر رو توی گروهت بفرست:\n\n<code>https://t.me/${me.username}?start=${code}</code>`, KB.main); }); return;
  }
  if (text === "🔗 لینک ناشناس من") {
    bot.getMe().then(async me => {
      const code = getChatCode(userId); const link = `https://t.me/${me.username}?start=${code}`;
      await send(userId, `سلام 🖐 هستم\n\nلینک زیر رو لمس کن و هر حرفی که تو دلت هست یا از روم داری رو با خیال راحت بنویس و بفرست. بدون اینکه از اسمت باخبر بشم راحتی ناشناس بهم پیام بده! خودمم می‌تونی امتحان کنی و از بقیه ناشناس بهت پیام بفرستن، حرفای خیلی جالبی می‌شنوی! 😉\n\n☝️☝️\n${link}\n\nTelegram\n\n<b>چت ناشناس</b>\nامن و معتبر ترین ربات ناشناس تلگرام\nنیمه گمشدت منتظره بهش پیام بدی :)`);
      send(userId, `☝️ پیام بالا رو به دوستات و گروههایی که می‌شناسی فوروارد کن.\n\nاینستاگرامی داری؟ لینک بالارو بزار بیوت پس ;)`, KB.main);
    }); return;
  }
  if (text === "🏆 افزایش امتیاز") {
    bot.getMe().then(async me => {
      const refCode = getRefCode(userId); const refLink = `https://t.me/${me.username}?start=${refCode}`;
      await send(userId, `یا این برنامه میتونی هر وقت بخوای به صورت تصادفی به یک نفر وصل بشی و کاملاً ناشناس گپ بزنی\n\n👇 شروع کن\n${refLink}`);
      send(userId, `اعتبار مکالمه شما : <b>${user.coins} سکه</b>\n\nبرای افزایش اعتبار، بنر مخصوص خودت رو به دوستات فوروارد کن.\nبه ازای هر کاربری که از طرف تو وارد ربات بشه 20 👈 سکه جدید می‌گیری! 😀\nبرای دریافت بنر 👈 /banner رو لمس کن`, KB.points);
    }); return;
  }
  if (text === "اعتبار رایگان") {
    const now = Date.now();
    if ((now - (user.lastFreeCoins||0)) > 86400000) {
      user.coins += FREE_DAILY_COINS; user.lastFreeCoins = now;
      send(userId, `🎁 <b>${FREE_DAILY_COINS} سکه رایگان</b> دریافت شد!\n💰 موجودی: <b>${user.coins} سکه</b>\n\nفردا دوباره بیا 😊`, KB.main);
    } else {
      const h = Math.ceil(((user.lastFreeCoins||0)+86400000-now)/3600000);
      send(userId, `⏰ امروز دریافت شده!\n\n<b>${h} ساعت</b> دیگه بیا 😊`, KB.main);
    }
    return;
  }
  if (text === "🔙 برگشت") { s.step = "idle"; send(userId, "حله!\nچه کاری برات انجام بدم؟", KB.main); return; }
  if (text === "راهنما") {
    bot.sendMessage(userId, `راهنما 🔍\n\nمن از اینجام که کمکت کنم 😀\nبرای دریافت راهنمایی در مورد هر موضوع، کافیه دکمه مورد نظر رو لمس کنی 👇`, {
      reply_markup: { inline_keyboard: [
        [{ text: "👈 این ربات چیه؟", callback_data: "help:what" }],
        [{ text: "👈 چطوری پیام ناشناس دریافت کنم؟", callback_data: "help:receive" }],
        [{ text: "👈 چطوری به مخاطب خاصم وصل بشم؟", callback_data: "help:specific" }],
        [{ text: "👈 چطوری به یه ناشناس تصادفی وصل شیم؟", callback_data: "help:random" }],
      ]}, parse_mode: "HTML"
    }); return;
  }
  send(userId, "حله!\nچه کاری برات انجام بدم؟", KB.main);
});

function forwardMsg(msg, pId) {
  try {
    if (msg.text) bot.sendMessage(pId, msg.text);
    else if (msg.photo) bot.sendPhoto(pId, msg.photo[msg.photo.length-1].file_id, { caption: msg.caption });
    else if (msg.sticker) bot.sendSticker(pId, msg.sticker.file_id);
    else if (msg.voice) bot.sendVoice(pId, msg.voice.file_id);
    else if (msg.video) bot.sendVideo(pId, msg.video.file_id, { caption: msg.caption });
    else if (msg.document) bot.sendDocument(pId, msg.document.file_id, { caption: msg.caption });
    else if (msg.audio) bot.sendAudio(pId, msg.audio.file_id);
    else if (msg.video_note) bot.sendVideoNote(pId, msg.video_note.file_id);
    else if (msg.animation) bot.sendAnimation(pId, msg.animation.file_id, { caption: msg.caption });
    else if (msg.location) bot.sendLocation(pId, msg.location.latitude, msg.location.longitude);
  } catch (e) { console.error("fwd err:", e.message); }
}

bot.on("polling_error", e => console.error("Polling error:", e.message));
console.log("✅ Bot started! Admins:", ADMIN_USERNAMES.join(", "));
