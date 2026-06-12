const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── State ────────────────────────────────────────────────────────
const users = new Map();   // userId → { gender, prefer, totalChats }
const sessions = new Map(); // userId → { step, partnerId, reportTarget }
const waitingPool = new Map(); // userId → preferGender

function getUser(id) {
  if (!users.has(id)) users.set(id, { gender: "any", prefer: "any", totalChats: 0, firstName: "" });
  return users.get(id);
}

function sess(id) {
  if (!sessions.has(id)) sessions.set(id, { step: "idle", partnerId: null, reportTarget: null });
  return sessions.get(id);
}

// ─── Keyboards ───────────────────────────────────────────────────
function kb(keys, oneTime = false) {
  return {
    keyboard: keys.map(row => row.map(text => ({ text }))),
    resize_keyboard: true,
    one_time_keyboard: oneTime,
  };
}

const KB = {
  gender:    kb([["👦 پسر", "👧 دختر"]], true),
  prefer:    kb([["👦 پسر", "👧 دختر"], ["🔀 فرقی نمیکنه"]], true),
  main:      kb([["🔍 جستجوی شریک"], ["👤 پروفایل من", "📊 آمار ربات"], ["🔗 لینک ناشناس من", "❓ راهنما"]]),
  searching: kb([["❌ لغو جستجو"]]),
  chat:      kb([["⏭ نفر بعدی", "❌ پایان چت"], ["🚨 گزارش"]]),
  report:    kb([["🔞 محتوای نامناسب"], ["🤬 توهین و فحاشی"], ["📢 اسپم / تبلیغات"], ["❌ انصراف"]], true),
};

function send(chatId, text, keyboard, extra = {}) {
  return bot.sendMessage(chatId, text, { reply_markup: keyboard, parse_mode: "HTML", ...extra });
}

// ─── Match logic ─────────────────────────────────────────────────
function startSearch(userId, prefer) {
  const s = sess(userId);
  const myUser = getUser(userId);

  for (const [candidateId, candidatePrefer] of waitingPool.entries()) {
    if (candidateId === userId) continue;
    const candidateUser = getUser(candidateId);
    const iWant = prefer === "any" || prefer === candidateUser.gender || candidateUser.gender === "any";
    const theyWant = candidatePrefer === "any" || candidatePrefer === myUser.gender || myUser.gender === "any";
    if (iWant && theyWant) {
      waitingPool.delete(candidateId);
      s.step = "in_chat"; s.partnerId = candidateId;
      const cs = sess(candidateId); cs.step = "in_chat"; cs.partnerId = userId;
      myUser.totalChats++; getUser(candidateId).totalChats++;
      const msg = "✅ <b>شریک پیدا شد!</b>\n\nشروع کن حرف بزنی 😊\nهویت هیچ‌کدوم فاش نمیشه 🔒\n\n⏭ <i>نفر بعدی</i> | ❌ <i>پایان چت</i>";
      send(userId, msg, KB.chat);
      send(candidateId, msg, KB.chat);
      return;
    }
  }

  waitingPool.set(userId, prefer);
  s.step = "waiting";
  const poolSize = waitingPool.size;
  send(userId, `🔍 <b>در حال جستجو...</b>\n\n${poolSize > 1 ? `${poolSize - 1} نفر دیگه هم منتظرن` : "منتظر یه نفر دیگه هستیم"}\n\nصبر کن پیدا بشه! 🕐`, KB.searching);
}

function doDisconnect(userId, notifyPartner = true) {
  const s = sess(userId);
  const partnerId = s.partnerId;
  waitingPool.delete(userId);
  s.step = "idle"; s.partnerId = null; s.reportTarget = null;
  if (partnerId) {
    const ps = sess(partnerId);
    ps.step = "idle"; ps.partnerId = null;
    if (notifyPartner) send(partnerId, "❌ <b>طرف مقابل چت رو ترک کرد.</b>\n\nبرای ادامه از منو زیر استفاده کن 👇", KB.main);
  }
}

// ─── /start ──────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.chat.id;
  const name = msg.from?.first_name ?? "کاربر";
  const user = getUser(userId);
  user.firstName = name;
  const s = sess(userId);

  const deepLink = match?.[1];
  if (deepLink?.startsWith("chat_")) {
    const targetId = parseInt(deepLink.replace("chat_", ""), 10);
    if (!isNaN(targetId) && targetId !== userId) {
      const ts = sess(targetId);
      if (ts.step === "idle") {
        s.step = "in_chat"; s.partnerId = targetId;
        ts.step = "in_chat"; ts.partnerId = userId;
        user.totalChats++; getUser(targetId).totalChats++;
        send(userId, "✅ <b>از طریق لینک شخصی وصل شدی!</b>\n\nچت شروع شد 🎉", KB.chat);
        send(targetId, "🔔 <b>یه نفر از طریق لینک شخصی‌ات اومد!</b>\n\nچت شروع شد 🎉", KB.chat);
        return;
      }
    }
  }

  if (user.gender === "any") {
    s.step = "set_gender";
    send(userId, `👋 سلام <b>${name}</b>!\n\nبه ربات چت ناشناس خوش اومدی 🎭\n\nاول بگو <b>جنسیت</b> تو چیه؟`, KB.gender);
    return;
  }

  send(userId, `👋 سلام <b>${name}</b>!\n\nاز منوی زیر انتخاب کن 👇`, KB.main);
  s.step = "idle";
});

// ─── Messages ────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const userId = msg.chat.id;
  const text = msg.text ?? "";
  const s = sess(userId);
  const user = getUser(userId);

  if (text.startsWith("/")) return;

  // set_gender
  if (s.step === "set_gender") {
    if (text === "👦 پسر") user.gender = "male";
    else if (text === "👧 دختر") user.gender = "female";
    else { send(userId, "لطفاً از دکمه‌های زیر انتخاب کن 👇", KB.gender); return; }
    s.step = "set_prefer";
    send(userId, `${user.gender === "male" ? "👦" : "👧"} ثبت شد!\n\nحالا بگو ترجیح میدی با <b>چه جنسیتی</b> چت کنی؟`, KB.prefer);
    return;
  }

  // set_prefer
  if (s.step === "set_prefer") {
    if (text === "👦 پسر") user.prefer = "male";
    else if (text === "👧 دختر") user.prefer = "female";
    else if (text === "🔀 فرقی نمیکنه") user.prefer = "any";
    else { send(userId, "لطفاً از دکمه‌های زیر انتخاب کن 👇", KB.prefer); return; }
    s.step = "idle";
    send(userId, `✅ <b>ثبت‌نام کامل شد!</b>\n\nسلام <b>${user.firstName}</b>! آماده‌ای؟ 🎉\n\nاز منوی زیر انتخاب کن 👇`, KB.main);
    return;
  }

  // report step
  if (s.step === "report") {
    let reason = "";
    if (text === "🔞 محتوای نامناسب") reason = "محتوای نامناسب";
    else if (text === "🤬 توهین و فحاشی") reason = "توهین و فحاشی";
    else if (text === "📢 اسپم / تبلیغات") reason = "اسپم / تبلیغات";
    else if (text === "❌ انصراف") { s.step = "in_chat"; send(userId, "❌ گزارش لغو شد.", KB.chat); return; }
    else { send(userId, "لطفاً از دکمه‌های زیر انتخاب کن 👇", KB.report); return; }
    console.log(`REPORT: ${userId} → ${s.reportTarget} | ${reason}`);
    s.step = "in_chat"; s.reportTarget = null;
    send(userId, `✅ گزارش ثبت شد!\nدلیل: <b>${reason}</b>\n\nممنون! بررسی میشه 🙏`, KB.chat);
    return;
  }

  // waiting
  if (s.step === "waiting") {
    if (text === "❌ لغو جستجو") {
      waitingPool.delete(userId); s.step = "idle";
      send(userId, "❌ جستجو لغو شد.\n\nبرای شروع دوباره از منو استفاده کن 👇", KB.main);
    } else { send(userId, "⏳ هنوز داری منتظری... صبر کن!", KB.searching); }
    return;
  }

  // in_chat
  if (s.step === "in_chat") {
    if (text === "⏭ نفر بعدی") { doDisconnect(userId); send(userId, "🔄 رفتیم سراغ نفر بعدی...", KB.searching); startSearch(userId, user.prefer); return; }
    if (text === "❌ پایان چت") { doDisconnect(userId); send(userId, "👋 <b>چت تموم شد.</b>\n\nهر وقت خواستی دوباره از منو شروع کن 👇", KB.main); return; }
    if (text === "🚨 گزارش") { s.reportTarget = s.partnerId; s.step = "report"; send(userId, "🚨 <b>دلیل گزارش رو انتخاب کن:</b>", KB.report); return; }
    if (!s.partnerId) { s.step = "idle"; send(userId, "⚠️ مشکلی پیش اومد. از منو دوباره شروع کن 👇", KB.main); return; }
    forwardMsg(msg, s.partnerId);
    return;
  }

  // idle / main menu
  if (text === "🔍 جستجوی شریک") { startSearch(userId, user.prefer); return; }
  if (text === "👤 پروفایل من") {
    const g = user.gender === "male" ? "👦 پسر" : user.gender === "female" ? "👧 دختر" : "❓ تعیین نشده";
    const p = user.prefer === "male" ? "👦 پسر" : user.prefer === "female" ? "👧 دختر" : "🔀 هر دو";
    send(userId, `👤 <b>پروفایل من</b>\n\n🏷 نام: <b>${user.firstName}</b>\n⚥ جنسیت: <b>${g}</b>\n💭 ترجیح: <b>${p}</b>\n💬 تعداد چت: <b>${user.totalChats}</b>\n\n/setgender — تغییر جنسیت`, KB.main);
    return;
  }
  if (text === "📊 آمار ربات") {
    const active = [...sessions.values()].filter(s => s.step === "in_chat").length / 2;
    send(userId, `📊 <b>آمار ربات</b>\n\n👥 کل کاربران: <b>${users.size}</b>\n💬 چت‌های فعال: <b>${Math.floor(active)}</b>\n⏳ در صف انتظار: <b>${waitingPool.size}</b>`, KB.main);
    return;
  }
  if (text === "🔗 لینک ناشناس من") {
    bot.getMe().then(me => {
      send(userId, `🔗 <b>لینک ناشناس شخصی تو:</b>\n\n<code>https://t.me/${me.username}?start=chat_${userId}</code>\n\nاین لینک رو برای هر کسی بفرست تا بدون اینکه هویتت رو بدونه باهات چت کنه! 🎭`, KB.main);
    });
    return;
  }
  if (text === "❓ راهنما") {
    send(userId, `❓ <b>راهنمای ربات</b>\n\n🔍 <b>جستجوی شریک</b> — وصل شدن به یه نفر ناشناس\n⏭ <b>نفر بعدی</b> — رفتن به نفر دیگه\n❌ <b>پایان چت</b> — پایان دادن به چت\n🚨 <b>گزارش</b> — گزارش طرف مقابل\n🔗 <b>لینک ناشناس</b> — لینک اختصاصی برای چت با تو\n\n📎 <i>می‌تونی پیام، عکس، ویدیو، صدا، استیکر، GIF، فایل و لوکیشن بفرستی</i>`, KB.main);
    return;
  }

  send(userId, "از منوی زیر انتخاب کن 👇", KB.main);
});

// /setgender
bot.onText(/\/setgender/, (msg) => {
  const userId = msg.chat.id;
  const s = sess(userId);
  if (s.step === "in_chat" || s.step === "waiting") { send(userId, "⚠️ اول چت رو تموم کن.", KB.chat); return; }
  s.step = "set_gender";
  send(userId, "جنسیت جدیدت رو انتخاب کن:", KB.gender);
});

function forwardMsg(msg, partnerId) {
  try {
    if (msg.text) bot.sendMessage(partnerId, `💬 ${msg.text}`);
    else if (msg.photo) bot.sendPhoto(partnerId, msg.photo[msg.photo.length - 1].file_id, { caption: msg.caption });
    else if (msg.sticker) bot.sendSticker(partnerId, msg.sticker.file_id);
    else if (msg.voice) bot.sendVoice(partnerId, msg.voice.file_id);
    else if (msg.video) bot.sendVideo(partnerId, msg.video.file_id, { caption: msg.caption });
    else if (msg.document) bot.sendDocument(partnerId, msg.document.file_id, { caption: msg.caption });
    else if (msg.audio) bot.sendAudio(partnerId, msg.audio.file_id);
    else if (msg.video_note) bot.sendVideoNote(partnerId, msg.video_note.file_id);
    else if (msg.animation) bot.sendAnimation(partnerId, msg.animation.file_id, { caption: msg.caption });
    else if (msg.location) bot.sendLocation(partnerId, msg.location.latitude, msg.location.longitude);
  } catch (e) { console.error("Forward error:", e.message); }
}

bot.on("polling_error", (err) => console.error("Polling error:", err.message));
console.log("✅ Anonymous chat bot started!");
