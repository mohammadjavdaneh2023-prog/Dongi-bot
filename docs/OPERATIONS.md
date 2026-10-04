# عملیات، migration و rollback

## راه‌اندازی از PostgreSQL خالی

1. database و user مستقل `dongi` با دسترسی فقط به همان database بسازید.
2. `DATABASE_URL` و Secretها را در محیط میزبان تعریف کنید.
3. `npm run migrate` را اجرا کنید.
4. فقط یک بار `npm run bootstrap-owner` را با اطلاعات Owner جدید اجرا کنید.
5. `npm start` را با یک Replica اجرا کنید.
6. `/healthz`, `/readyz`, `/version` را بررسی کنید.

Startup نیز migration را idempotent اجرا می‌کند، اما اجرای جداگانه پیش از Deploy تشخیص خطا را ساده‌تر می‌کند. هیچ migration یا ابزار import برای SQLite وجود ندارد.

## مشاهده‌پذیری

logها JSON روی stdout/stderr هستند. `trace_id` عملیات را پیوند می‌دهد. Token، API key، Session، شماره تلفن، متن پیام، prompt، پاسخ خام provider و exception خام ثبت نمی‌شوند. log collector میزبان باید retention و دسترسی محدود داشته باشد.

برای outbox، وضعیت `AMBIGUOUS` یا `SENDING` قدیمی هشدار عملیاتی است. اپراتور ابتدا Telegram و context را بررسی می‌کند؛ تغییر وضعیت برای retry فقط پس از اثبات ارسال‌نشدن مجاز است.

## Rollback کد

تصویر قبلیِ immutable را با همان Secretها Deploy کنید. migrationها forward-only و غیرمخرب‌اند؛ schema را rollback نکنید. اگر نسخهٔ قبلی با schema جدید سازگار نیست، یک release اصلاحی forward بسازید. پیش از migration پرخطر بکاپ مستقل و Restore آزموده لازم است.

## انتشار GitHub

Branch جدا، PR، CI موفق و تأیید مالک پیش از merge لازم است. پس از اولین Push، روی `main` Ruleset/Branch Protection برای منع direct push و force-push و الزام PR و check `ci / verify` فعال شود. ساخت remote، Push و تغییر تنظیمات Repository خارج از این آماده‌سازی است.

## محدودیت‌ها

- نسخهٔ اولیه یک Replica است؛ وقفهٔ کوتاه Deploy پذیرفته می‌شود.
- تست واقعی Telegram/Gemini بخشی از CI نیست و باید با حساب‌ها و Botهای جدید به‌صورت کنترل‌شده انجام شود.
- facade همگام PostgreSQL برای بار بسیار بالا benchmark نشده است.
- rotation خودکار `APP_ENCRYPTION_KEY` هنوز ابزار جدا ندارد.
