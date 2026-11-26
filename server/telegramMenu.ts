import { issueTelegramConnectionCode, telegramIdentity, telegramSubscriptionText } from './telegramLink.js';
import type { MobileDatabase } from './presence.js';

const keyboard = {
  keyboard: [[{ text: 'پشتیبانی' }, { text: 'اتصال به برنامه' }], [{ text: 'تعرفه ها' }, { text: 'وضعیت اشتراک' }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'یک گزینه انتخاب کنید',
};

export async function createTelegramMenuReply(database: Pick<MobileDatabase, 'query'>, message: any, botId: string | number, updateId: number) {
  if (message.chat.type !== 'private' || message.from?.is_bot) return null;
  const command = typeof message.text === 'string' ? message.text.trim().replace(/\u200c/g, ' ') : '';
  let text: string;
  let parseMode: 'HTML' | undefined;
  if (/^\/(start|menu)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(command)) {
    text = 'سلام! از منوی پایین یک گزینه را انتخاب کنید.';
  } else if (command === 'پشتیبانی') {
    text = 'پیام یا سؤال خود را همین‌جا بفرستید. پاسخ پشتیبانی را هم در همین گفت‌وگو دریافت می‌کنید.';
  } else if (command === 'اتصال به برنامه') {
    const identity = telegramIdentity(message);
    if (!identity) return null;
    const linked = await database.query(`SELECT 1 FROM telegram_user_links l JOIN users u ON u.id=l.user_id
      WHERE l.bot_id=$1 AND l.telegram_user_id=$2`, [botId, identity.id]);
    if (linked.rowCount) {
      text = 'ربات با موفقیت متصل شد';
    } else {
      const code = await issueTelegramConnectionCode(database, botId, updateId, identity);
      text = `کد اتصال به برنامه:\n\n<code>${code}</code>\n\nدر تب پروفایل برنامه، آیکن تلگرام را بزنید و این کد را وارد کنید.\nکد یک‌بارمصرف است و ۱۰ دقیقه اعتبار دارد. برای کپی، روی کد بزنید.`;
      parseMode = 'HTML';
    }
  } else if (command === 'وضعیت اشتراک') {
    const identity = telegramIdentity(message);
    if (!identity) return null;
    text = await telegramSubscriptionText(database, botId, identity);
  } else if (command === 'تعرفه ها') {
    const plans = (await database.query<any>(`SELECT name,price_irr,quota_bytes,duration_days
      FROM subscription_plans WHERE active=TRUE AND is_trial=FALSE ORDER BY price_irr,id LIMIT 12`)).rows;
    text = plans.length ? 'تعرفه‌های فعلی:\n\n' : 'در حال حاضر تعرفه‌ای فعال نیست. برای راهنمایی «پشتیبانی» را انتخاب کنید.';
    for (const plan of plans) {
      const price = BigInt(plan.price_irr || 0);
      const quota = (Number(plan.quota_bytes) / 1073741824).toLocaleString('fa-IR', { maximumFractionDigits: 2 });
      text += `${String(plan.name).slice(0, 80)}\nحجم: ${quota} گیگابایت\nمدت: ${Number(plan.duration_days).toLocaleString('fa-IR')} روز\nقیمت: ${price === 0n ? 'رایگان' : price.toLocaleString('fa-IR') + ' تومان'}\n\n`;
    }
  } else {
    text = 'پیام شما برای پشتیبانی دریافت شد. می‌توانید از منوی پایین هم استفاده کنید.';
  }
  // Telegram can send this message directly from the JSON webhook response.
  return { method: 'sendMessage', chat_id: String(message.chat.id), text: text.trim().slice(0, 4096), reply_markup: keyboard,
    ...(parseMode ? { parse_mode: parseMode } : {}) };
}
