# رفتار فعلی DONGI

## مسیرهای اصلی کاربر

1. مالک با `npm run bootstrap-owner` در دیتابیس خالی رزرو می‌شود و سپس در خصوصی `/start` می‌زند.
2. مالک با `#DONGI user create "Name"` پروفایل رزروشده و دعوت یک‌بارمصرف می‌سازد؛ شناسه و نام تا یک ساعت رزرو می‌مانند. فقط `/start TOKEN` پذیرفته‌شده پیش از انقضا حساب را فعال می‌کند؛ در غیر این صورت رزرو آزاد می‌شود.
3. اعضای فعال در گروه فاکتور یا تسویه ثبت می‌کنند. عضویت Telegram و وضعیت حساب پیش از Commit بررسی می‌شود.
4. Update، عملیات دامنه، Audit و پاسخ رمزگذاری‌شده در یک تراکنش ثبت می‌شوند. Update تکراری عملیات را دوباره اجرا نمی‌کند.
5. outbox پاسخ را ارسال می‌کند. نتیجهٔ قطعی ثبت می‌شود؛ نتیجهٔ شبکه‌ای مبهم `AMBIGUOUS` می‌ماند و خودکار دوباره ارسال نمی‌شود.
6. کاربر دادهٔ شخصی را از `/my` می‌خواند و در گروه تراز، جزئیات، بانک یا مدیریت مجاز را اجرا می‌کند.

## فرمان‌های اصلی

- `/start` و `/start TOKEN`
- `/my balance|open|history|invoices|profile|aliases|banks|help [page]`
- `#DONGI help`
- `#DONGI user create "Name" [PUBLIC_ID]` و `#DONGI user invite PUBLIC_ID`
- `#DONGI invoice ...`, `#DONGI settle ...`, `#DONGI balance`, `#DONGI settle-plan`
- `#DONGI details [#REF]`, `#DONGI void [#REF]`, `#DONGI restore [#REF]`
- `#DONGI alias PUBLIC_ID add|remove ALIAS`
- `#DONGI freeze|unfreeze PUBLIC_ID`
- `#DONGI user suspend|activate PUBLIC_ID`
- `#DONGI bank create|charge|refund|spend|report ...`
- پیام «هی دنگی ...» برای پیشنهاد AI؛ ثبت فقط پس از تأیید همان کاربر در همان گروه تا پنج دقیقه

## داده‌های پایدار

PostgreSQL کاربران، دعوت‌ها، Aliasها، نقش‌ها و محدودیت‌های گروهی، فاکتورها و ردیف‌ها، تخصیص تسویه و تهاتر، بانک‌ها و گردش‌ها، Audit append-only، Updateهای پردازش‌شده، offset، pending AI، outbox ارسال، temporary messageها و receipt mapping را نگه می‌دارد.

هیچ رسانه یا فایل کاربری پایدار تولید نمی‌شود. متن خام کاربر، prompt و پاسخ خام AI در log ذخیره نمی‌شوند.

## سرویس‌های خارجی

- Telegram Bot API برای polling، عضویت و ارسال/حذف پیام
- Gemini API با یک کلید داخلی سراسری که مالک محصول در Secretهای میزبان تنظیم می‌کند
- PostgreSQL خارجی برای همهٔ داده‌های پایدار

هیچ سرویس Cloudflare، Railway، S3 یا سرویس خارجی دیگری در مسیر فعلی لازم نیست.

## قواعد مهم

- یک polling consumer؛ PostgreSQL advisory lock روی اتصال اختصاصی، handoff نسخه‌ها را بدون polling هم‌زمان انجام می‌دهد. Replica جایگزین هنگام rolling release در حالت Ready منتظر آزادشدن قفل می‌ماند.
- عملیات مالی و مدیریتی idempotent و Auditشده‌اند.
- ارسال مبهم قابل retry خودکار نیست؛ اپراتور باید وضعیت را بررسی کند.
- نقش Admin از Telegram تازه بررسی می‌شود. Owner هم محدودیت‌های عضویت عملیات بانکی را دور نمی‌زند.
- AI فقط پیشنهاد می‌دهد؛ حسابداری، هویت، عضویت، zero-sum و تخصیص در کد کنترل می‌شوند.
- کاربران به کلید داخلی AI دسترسی ندارند و نیازی به ارائهٔ کلید شخصی ندارند.

## اختلاف اسناد قدیمی با کد

نسخهٔ قبلی در برخی اسناد SQLite، log فایل‌محور و حذف پاسخ‌های pending هنگام restart را توصیف می‌کرد. آن اسناد حذف شدند؛ رفتار مرجع اکنون PostgreSQL، stdout JSON، کلید AI داخلی سراسری و outbox پایدار/ambiguous-safe است. تست‌های کد منبع اصلی رفتارند.
