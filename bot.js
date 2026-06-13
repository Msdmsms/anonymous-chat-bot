const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

// ─── Config ──────────────────────────────────────────────────────
const ADMIN_USERNAME = "Mojeao";
let ADMIN_ID = null;
let FORCE_JOIN_CHANNEL = null;
const REFERRAL_COINS = 20;
const FREE_DAILY_COINS = 3;

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── Store ────────────────────────────────────────────────────────
const users = new Map();
const sessions = new Map();
const waitingPool = new Map();
const adminBroadcastPending = new Set();

function getUser(id, firstName, username) {
  if (!users.has(id)) {
    users.set(id, { firstName: firstName || "", username: username || null, gender: "any", prefer: "any", coins: 5, totalChats: 0, referredBy: null, lastFreeCoins: 0, banned: false });
  }
  const u = users.get(id);
  if (firstName) u.firstName = firstName;
  if (username) u.username = username;
  return u;
}

function sess(id) {
  if (!sessions.has(id)) sessions.set(id, { step: "idle", partnerId: null, reportTarget: null });
  return sessions.get(id);
}

// ─── Keyboards ───────────────────────────────────────────────────
function kb(keys, oneTime) {
  return { keyboard: keys.map(r => r.map(t => ({ text: t }))), resize_keyboard: true, one_time_keyboard: !!oneTime };
}

const KB = {
  main:      kb([["🔗 به یه ناشناس وصلم کن!"], ["❤️ به مخاطب خاصم وصلم کن!"], ["👥 پیام ناشناس به گروه", "🔗 لینک ناشناس من"], ["🏆 افزایش امتیاز", "راهنما"]]),
  gender:    kb([["👦 پسر", "👧 دختر"]], true),
  prefer:    kb([["👦 پسر", "👧 دختر"], ["🔀 فرقی نمیکنه"]], true),
  searching: kb([["❌ لغو جستجو"]]),
  chat:      kb([["⏭ نفر بعدی", "❌ پایان چت"], ["🚨 گزارش"]]),
  report:    kb([["🔞 محتوای نامناسب"], ["🤬 توهین و فحاشی"], ["📢 اسپم / تبلیغات"], ["❌ انصراف"]], true),
  cancel:    kb([["❌ انصراف"]], true),
  points:    kb([["🎁 اعتبار رایگان"], ["🔙 برگشت"]]),
  admin:     kb([["📢 پیام همگانی"], ["📌 تنظیم جوین اجباری", "❌ حذف جوین اجباری"], ["📊 آمار کاربران", "🔙 برگشت"]]),
};

function send(chatId, text, keyboard, extra) {
  return bot.sendMessage(chatId, text, Object.assign({ reply_markup: keyboard, parse_mode: "HTML" }, extra || {}))
    .catch(e => console.error("send error:", e.message));
}

// ─── Force join ───────────────────────────────────────────────────
async function checkJoin(userId) {
  if (!FORCE_JOIN_CHANNEL) return true;
  try {
    const m = await bot.getChatMember(FORCE_JOIN_CHANNEL, userId);
    return ["member", "administrator", "creator"].includes(m.status);
  } catch { return false; }
}

async function requireJoin(userId) {
  if (await checkJoin(userId)) return true;
  bot.sendMessage(userId,
    `⚠️ برای استفاده از ربات باید عضو کانال زیر بشی:\n\n${FORCE_JOIN_CHANNEL}\n\nبعد از جوین دوباره /start بزن.`,
    { reply_markup: { inline_keyboard: [[{ text: "🔗 عضویت در کانال", url: `https://t.me/${FORCE_JOIN_CHANNEL.replace("@", "")}` }]] } }
  );
  return false;
}

// ─── Match logic ──────────────────────────────────────────────────
function startSearch(userId, prefer) {
  const s = sess(userId);
  const myUser = users.get(userId);
  for (const [cId, cPrefer] of waitingPool.entries()) {
    if (cId === userId) continue;
    const cu = users.get(cId);
    const myG = myUser ? myUser.gender : "any";
    const cuG = cu ? cu.gender : "any";
    const iWant = prefer === "any" || prefer === cuG || cuG === "any";
    const theyWant = cPrefer === "any" || cPrefer === myG || myG === "any";
    if (iWant && theyWant) {
      waitingPool.delete(cId);
      s.step = "in_chat"; s.partnerId = cId;
      const cs = sess(cId); cs.step = "in_chat"; cs.partnerId = userId;
      if (myUser) myUser.totalChats++;
      if (cu) cu.totalChats++;
      const m = "✅ <b>شریک پیدا شد!</b>\n\nشروع کن حرف بزنی 😊\nهویت هیچ‌کدوم فاش نمیشه 🔒\n\n⏭ نفر بعدی  |  ❌ پایان چت";
      send(userId, m, KB.chat);
      send(cId, m, KB.chat);
      return;
    }
  }
  waitingPool.set(userId, prefer);
  s.step = "waiting";
  const q = waitingPool.size;
  send(userId, `🔍 <b>در حال جستجو...</b>\n\n${q > 1 ? `${q - 1} نفر دیگه هم منتظرن` : "منتظر یه نفر دیگه هستیم"}\n\nصبر کن پیدا بشه! 🕐`, KB.searching);
}

function doDisconnect(userId, notifyPartner) {
  const s = sess(userId);
  const pId = s.partnerId;
  waitingPool.delete(userId);
  s.step = "idle"; s.partnerId = null; s.reportTarget = null;
  if (pId) {
    const ps = sess(pId); ps.step = "idle"; ps.partnerId = null;
    if (notifyPartner !== false) send(pId, "❌ <b>طرف مقابل چت رو ترک کرد.</b>\n\nاز منوی زیر ادامه بده 👇", KB.main);
  }
}

// ─── /start ───────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.chat.id;
  const firstName = (msg.from && msg.from.first_name) || "کاربر";
  const username = (msg.from && msg.from.username) || null;
  if (username === ADMIN_USERNAME && !ADMIN_ID) ADMIN_ID = userId;
  const user = getUser(userId, firstName, username);
  if (user.banned) { send(userId, "⛔ حساب شما مسدود شده است."); return; }

  const deep = (match && match[1]) || "";

  if (deep.startsWith("ref_")) {
    const rId = parseInt(deep.replace("ref_", ""), 10);
    if (!isNaN(rId) && rId !== userId && !user.referredBy) {
      user.referredBy = rId;
      const ref = users.get(rId);
      if (ref) {
        ref.coins += REFERRAL_COINS;
        send(rId, `🎉 یه نفر با لینک دعوت تو وارد ربات شد!\n\n🪙 <b>+${REFERRAL_COINS} سکه</b> به حسابت اضافه شد.\nموجودی: <b>${ref.coins} سکه</b>`);
      }
    }
  }

  if (deep.startsWith("chat_")) {
    const tId = parseInt(deep.replace("chat_", ""), 10);
    if (!isNaN(tId) && tId !== userId) {
      if (!(await requireJoin(userId))) return;
      const ts = sess(tId);
      if (ts.step === "idle") {
        const s = sess(userId); s.step = "in_chat"; s.partnerId = tId;
        ts.step = "in_chat"; ts.partnerId = userId;
        user.totalChats++; const tu = users.get(tId); if (tu) tu.totalChats++;
        send(userId, "✅ <b>از طریق لینک شخصی وصل شدی!</b>\n\nچت شروع شد 🎉", KB.chat);
        send(tId, "🔔 <b>یه نفر از طریق لینک شخصی‌ات اومد!</b>\n\nچت شروع شد 🎉", KB.chat);
        return;
      }
      send(userId, "⚠️ این کاربر الان در دسترس نیست.", KB.main);
      return;
    }
  }

  if (!(await requireJoin(userId))) return;

  if (user.gender === "any") {
    sess(userId).step = "set_gender";
    send(userId, `👋 سلام <b>${firstName}</b>!\n\nبه <b>چت ناشناس</b> خوش اومدی 🎭\n\nاول بگو <b>جنسیت</b> تو چیه؟`, KB.gender);
    return;
  }
  sess(userId).step = "idle";
  send(userId, `👋 سلام <b>${firstName}</b>!\n\nاز منوی زیر انتخاب کن 👇`, KB.main);
});

// ─── /admin ───────────────────────────────────────────────────────
bot.onText(/\/admin/, (msg) => {
  const userId = msg.chat.id;
  if ((msg.from && msg.from.username) === ADMIN_USERNAME) {
    if (!ADMIN_ID) ADMIN_ID = userId;
    send(userId, "👑 <b>پنل ادمین</b>", KB.admin);
  }
});

bot.onText(/\/ban (\d+)/, (msg, match) => {
  if (!msg.from || msg.from.username !== ADMIN_USERNAME) return;
  const tId = parseInt(match[1], 10);
  const u = users.get(tId);
  if (u) { u.banned = true; send(msg.chat.id, `✅ کاربر ${tId} بن شد.`); doDisconnect(tId, true); }
  else send(msg.chat.id, "❌ کاربر پیدا نشد.");
});

bot.onText(/\/unban (\d+)/, (msg, match) => {
  if (!msg.from || msg.from.username !== ADMIN_USERNAME) return;
  const tId = parseInt(match[1], 10);
  const u = users.get(tId);
  if (u) { u.banned = false; send(msg.chat.id, `✅ کاربر ${tId} آنبن شد.`); }
  else send(msg.chat.id, "❌ کاربر پیدا نشد.");
});

bot.onText(/\/setgender/, (msg) => {
  const userId = msg.chat.id;
  const s = sess(userId);
  if (s.step === "in_chat" || s.step === "waiting") { send(userId, "⚠️ اول چت رو تموم کن.", KB.chat); return; }
  s.step = "set_gender";
  send(userId, "جنسیت جدیدت رو انتخاب کن:", KB.gender);
});

// ─── Messages ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const userId = msg.chat.id;
  const text = msg.text || "";
  const firstName = (msg.from && msg.from.first_name) || "کاربر";
  const username = (msg.from && msg.from.username) || null;
  if (username === ADMIN_USERNAME && !ADMIN_ID) ADMIN_ID = userId;
  if (text.startsWith("/")) return;

  const user = getUser(userId, firstName, username);
  if (user.banned) return;
  const s = sess(userId);

  // admin broadcast collection
  if (adminBroadcastPending.has(userId)) {
    adminBroadcastPending.delete(userId);
    if (text === "❌ انصراف") { send(userId, "❌ لغو شد.", KB.admin); return; }
    let sent = 0, failed = 0;
    const allUsers = [...users.keys()];
    for (const uid of allUsers) {
      if (uid === userId) continue;
      try {
        if (msg.text) await bot.sendMessage(uid, msg.text, { parse_mode: "HTML" });
        else await bot.copyMessage(uid, userId, msg.message_id);
        sent++;
        await new Promise(r => setTimeout(r, 35));
      } catch { failed++; }
    }
    send(userId, `✅ پیام همگانی ارسال شد!\n📤 موفق: <b>${sent}</b>\n❌ ناموفق: <b>${failed}</b>`, KB.admin);
    return;
  }

  // admin panel buttons
  if (userId === ADMIN_ID) {
    if (text === "📢 پیام همگانی") { adminBroadcastPending.add(userId); send(userId, "📢 پیامت رو بفرست (هر نوع پیامی):", KB.cancel); return; }
    if (text === "📊 آمار کاربران") {
      const active = Math.floor([...sessions.values()].filter(x => x.step === "in_chat").length / 2);
      send(userId, `📊 <b>آمار</b>\n\n👥 کاربران: <b>${users.size}</b>\n💬 چت فعال: <b>${active}</b>\n⏳ صف انتظار: <b>${waitingPool.size}</b>\n📌 جوین اجباری: <b>${FORCE_JOIN_CHANNEL || "ندارد"}</b>`, KB.admin);
      return;
    }
    if (text === "📌 تنظیم جوین اجباری") { s.step = "admin_set_join"; send(userId, "یوزرنیم کانال رو بفرست (مثال: @mychannel):", KB.cancel); return; }
    if (text === "❌ حذف جوین اجباری") { FORCE_JOIN_CHANNEL = null; send(userId, "✅ جوین اجباری حذف شد.", KB.admin); return; }
    if (s.step === "admin_set_join") {
      if (text === "❌ انصراف") { s.step = "idle"; send(userId, "❌ لغو.", KB.admin); return; }
      FORCE_JOIN_CHANNEL = text.startsWith("@") ? text : "@" + text;
      s.step = "idle";
      send(userId, `✅ جوین اجباری: <b>${FORCE_JOIN_CHANNEL}</b>`, KB.admin);
      return;
    }
    if (text === "🔙 برگشت" && (s.step === "idle" || s.step === "admin_set_join")) { s.step = "idle"; send(userId, "منوی اصلی 👇", KB.main); return; }
  }

  // set_gender
  if (s.step === "set_gender") {
    if (text === "👦 پسر") user.gender = "male";
    else if (text === "👧 دختر") user.gender = "female";
    else { send(userId, "از دکمه‌های زیر انتخاب کن 👇", KB.gender); return; }
    s.step = "set_prefer";
    send(userId, `${user.gender === "male" ? "👦" : "👧"} ثبت شد!\n\nترجیح میدی با <b>چه جنسیتی</b> چت کنی؟`, KB.prefer);
    return;
  }

  // set_prefer
  if (s.step === "set_prefer") {
    if (text === "👦 پسر") user.prefer = "male";
    else if (text === "👧 دختر") user.prefer = "female";
    else if (text === "🔀 فرقی نمیکنه") user.prefer = "any";
    else { send(userId, "از دکمه‌های زیر انتخاب کن 👇", KB.prefer); return; }
    s.step = "idle";
    send(userId, `✅ <b>ثبت‌نام کامل شد!</b>\n\nسلام <b>${user.firstName}</b>! آماده‌ای؟ 🎉\n\nاز منوی زیر انتخاب کن 👇`, KB.main);
    return;
  }

  // waiting
  if (s.step === "waiting") {
    if (text === "❌ لغو جستجو") { waitingPool.delete(userId); s.step = "idle"; send(userId, "❌ جستجو لغو شد.", KB.main); }
    else send(userId, "⏳ هنوز داری منتظری...", KB.searching);
    return;
  }

  // report
  if (s.step === "report") {
    const rs = { "🔞 محتوای نامناسب": "محتوای نامناسب", "🤬 توهین و فحاشی": "توهین و فحاشی", "📢 اسپم / تبلیغات": "اسپم / تبلیغات" };
    if (text === "❌ انصراف") { s.step = "in_chat"; send(userId, "❌ لغو شد.", KB.chat); return; }
    const reason = rs[text];
    if (!reason) { send(userId, "از دکمه انتخاب کن 👇", KB.report); return; }
    console.log(`REPORT: ${userId} → ${s.reportTarget} | ${reason}`);
    s.step = "in_chat"; s.reportTarget = null;
    send(userId, `✅ گزارش ثبت شد! دلیل: <b>${reason}</b>\nممنون 🙏`, KB.chat);
    return;
  }

  // connect_specific
  if (s.step === "connect_specific") {
    if (text === "❌ انصراف") { s.step = "idle"; send(userId, "❌ لغو شد.", KB.main); return; }
    let targetId = null;
    if (text.startsWith("@")) {
      const tUser = text.slice(1).toLowerCase();
      for (const [uid, u] of users.entries()) {
        if (u.username && u.username.toLowerCase() === tUser) { targetId = uid; break; }
      }
      if (!targetId) { send(userId, `❌ کاربر <b>${text}</b> در ربات پیدا نشد.\n\nاین کاربر باید قبلاً ربات رو استارت کرده باشه.\n\nیا یه پیام ازش فوروارد کن 👇`, KB.cancel); return; }
    }
    if (!targetId && msg.forward_from) targetId = msg.forward_from.id;
    if (!targetId) { send(userId, "⚠️ @Username بفرست یا یه پیام از اون شخص فوروارد کن:", KB.cancel); return; }
    if (targetId === userId) { send(userId, "❌ نمیتونی با خودت چت کنی!", KB.cancel); return; }
    const ts = sess(targetId);
    if (ts.step !== "idle") { s.step = "idle"; send(userId, "⚠️ این کاربر الان در دسترس نیست.", KB.main); return; }
    s.step = "in_chat"; s.partnerId = targetId;
    ts.step = "in_chat"; ts.partnerId = userId;
    user.totalChats++; const tu = users.get(targetId); if (tu) tu.totalChats++;
    send(userId, "✅ <b>وصل شدی!</b>\n\nچت شروع شد 🎉\nهویتت فاش نمیشه 🔒", KB.chat);
    send(targetId, "🔔 <b>یه نفر ناشناس میخواد باهات چت کنه!</b>\n\nچت شروع شد 🎉", KB.chat);
    return;
  }

  // in_chat
  if (s.step === "in_chat") {
    if (text === "⏭ نفر بعدی") { doDisconnect(userId); send(userId, "🔄 سراغ نفر بعدی...", KB.searching); startSearch(userId, user.prefer); return; }
    if (text === "❌ پایان چت") { doDisconnect(userId); send(userId, "👋 <b>چت تموم شد.</b>\n\nاز منوی زیر ادامه بده 👇", KB.main); return; }
    if (text === "🚨 گزارش") { s.reportTarget = s.partnerId; s.step = "report"; send(userId, "🚨 دلیل گزارش:", KB.report); return; }
    if (!s.partnerId) { s.step = "idle"; send(userId, "⚠️ مشکلی پیش اومد.", KB.main); return; }
    forwardMsg(msg, s.partnerId);
    return;
  }

  // idle / main menu
  if (text === "🔗 به یه ناشناس وصلم کن!") {
    if (!(await requireJoin(userId))) return;
    startSearch(userId, user.prefer);
    return;
  }
  if (text === "❤️ به مخاطب خاصم وصلم کن!") {
    if (!(await requireJoin(userId))) return;
    s.step = "connect_specific";
    send(userId,
      `❤️ <b>وصل شدن به مخاطب خاص</b>\n\nبرای اینکه بتونم به مخاطب خاصت بطور ناشناس وصلت کنم، یکی از این ۲ کار رو انجام بده:\n\n` +
      `👈 <b>راه اول :</b> @Username ← همون آی‌دی تلگرام اون شخص رو وارد ربات کن!\n\n` +
      `👈 <b>راه دوم :</b> الان یه پیام متنی از اون شخص به این ربات فوروارد کن تا ببینیم عضو هست یا نه!`,
      KB.cancel);
    return;
  }
  if (text === "👥 پیام ناشناس به گروه") {
    bot.getMe().then(me => {
      const link = `https://t.me/${me.username}?start=chat_${userId}`;
      send(userId, `👥 <b>پیام ناشناس به گروه</b>\n\nلینک زیر رو توی گروهت بفرست.\nهر کسی کلیک کنه بدون اینکه هویتش رو بدونی باهات چت میکنه! 🎭\n\n<code>${link}</code>`, KB.main);
    });
    return;
  }
  if (text === "🔗 لینک ناشناس من") {
    bot.getMe().then(async me => {
      const link = `https://t.me/${me.username}?start=chat_${userId}`;
      const refLink = `https://t.me/${me.username}?start=ref_${userId}`;
      await send(userId, `☝️☝️\n${link}\n\n<b>چت ناشناس</b>\nامن و معتبر ترین ربات ناشناس تلگرام\nنیمه گمشدت منتظره بهش پیام بدی :)`);
      send(userId,
        `☝️ پیام بالا رو به دوستات و گروههایی که می‌شناسی فوروارد کن یا لینک داخلش رو تو شبکه‌های اجتماعی بذار، تا بقیه بتونن بهت پیام ناشناس بفرستن. پیام‌ها از طریق همین برنامه بهت می‌رسه.\n\n` +
        `اینستاگرامی داری؟ لینک بالارو بزار بیوت پس ;)\n\n` +
        `🔗 <b>لینک دعوت (کسب سکه):</b>\n<code>${refLink}</code>\nبه ازای هر نفر: <b>+${REFERRAL_COINS} سکه</b> 🪙`,
        KB.main);
    });
    return;
  }
  if (text === "🏆 افزایش امتیاز") {
    bot.getMe().then(me => {
      const refLink = `https://t.me/${me.username}?start=ref_${userId}`;
      send(userId,
        `🏆 <b>افزایش امتیاز</b>\n\n💰 اعتبار فعلی مکالمه شما : <b>${user.coins} سکه</b>\n\n━━━━━━━━━━━━━━━━\n\n❓ چطور اعتبار مکالمه‌مو افزایش بدم ؟\n\n━━━━━━━━━━━━━━━━\n\n1️⃣ روش اول (رایگان) :\n\nبرای افزایش اعتبار بنر مخصوص خودت رو به دوستات فوروارد کن. به ازای هر کاربری که از طرف تو وارد ربات بشه ${REFERRAL_COINS} سکه جدید می‌گیری! 😄\nلینک دعوت تو 👇\n<code>${refLink}</code>`,
        KB.points);
    });
    return;
  }
  if (text === "🎁 اعتبار رایگان") {
    const now = Date.now();
    if ((now - (user.lastFreeCoins || 0)) > 86400000) {
      user.coins += FREE_DAILY_COINS; user.lastFreeCoins = now;
      send(userId, `🎁 <b>${FREE_DAILY_COINS} سکه رایگان</b> به حسابت اضافه شد!\n💰 موجودی: <b>${user.coins} سکه</b>\n\nفردا دوباره بیا 😊`, KB.main);
    } else {
      const hours = Math.ceil(((user.lastFreeCoins || 0) + 86400000 - now) / 3600000);
      send(userId, `⏰ امروز دریافت شده!\n\n<b>${hours} ساعت</b> دیگه بیا 😊`, KB.main);
    }
    return;
  }
  if (text === "🔙 برگشت") { s.step = "idle"; send(userId, "از منوی زیر انتخاب کن 👇", KB.main); return; }
  if (text === "راهنما") {
    send(userId,
      `❓ <b>راهنمای ربات</b>\n\n` +
      `🔗 <b>به یه ناشناس وصلم کن</b> — وصل شدن به یه غریبه ناشناس\n\n` +
      `❤️ <b>به مخاطب خاصم وصلم کن</b> — چت ناشناس با کسی که میشناسیش\n\n` +
      `👥 <b>پیام ناشناس به گروه</b> — دریافت پیام ناشناس از اعضای گروهت\n\n` +
      `🔗 <b>لینک ناشناس من</b> — لینک اختصاصی برای دریافت پیام ناشناس\n\n` +
      `🏆 <b>افزایش امتیاز</b> — کسب سکه رایگان از طریق دعوت دوستان\n\n` +
      `📎 <i>پیام، عکس، ویدیو، صدا، استیکر، GIF، فایل و لوکیشن پشتیبانی میشه</i>`,
      KB.main);
    return;
  }

  send(userId, "از منوی زیر انتخاب کن 👇", KB.main);
});

function forwardMsg(msg, pId) {
  try {
    if (msg.text) bot.sendMessage(pId, `💬 ${msg.text}`);
    else if (msg.photo) bot.sendPhoto(pId, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption });
    else if (msg.sticker) bot.sendSticker(pId, msg.sticker.file_id);
    else if (msg.voice) bot.sendVoice(pId, msg.voice.file_id);
    else if (msg.video) bot.sendVideo(pId, msg.video.file_id, { caption: msg.caption });
    else if (msg.document) bot.sendDocument(pId, msg.document.file_id, { caption: msg.caption });
    else if (msg.audio) bot.sendAudio(pId, msg.audio.file_id);
    else if (msg.video_note) bot.sendVideoNote(pId, msg.video_note.file_id);
    else if (msg.animation) bot.sendAnimation(pId, msg.animation.file_id, { caption: msg.caption });
    else if (msg.location) bot.sendLocation(pId, msg.location.latitude, msg.location.longitude);
  } catch (e) { console.error("forward error:", e.message); }
}

bot.on("polling_error", e => console.error("Polling error:", e.message));
console.log("✅ Bot started!");
