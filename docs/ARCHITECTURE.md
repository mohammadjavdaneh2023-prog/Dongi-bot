# معماری

DONGI یک process Node.js 24 با سه مرز اصلی است: Telegram adapter، منطق دامنه و PostgreSQL. parserها و قواعد مالی pure باقی مانده‌اند. Repositoryها از یک facade همگام استفاده می‌کنند که queryهای PostgreSQL را در Worker اجرا می‌کند؛ این انتخاب تراکنش‌های کوتاه و رفتار دامنهٔ موجود را حفظ کرده و مهاجرت پرریسک کل برنامه به async را حذف کرده است. این facade برای throughput یک Replica طراحی شده و در مقیاس بالاتر باید اندازه‌گیری شود.

Startup migrationها را زیر advisory lock و در تراکنش اجرا می‌کند. migration اعمال‌شده ویرایش نمی‌شود؛ تغییر بعدی فایل شماره‌دار جدید می‌گیرد. `schema_migrations` نسخه‌ها را ثبت می‌کند.

یک اتصال PostgreSQL اختصاصی advisory lock مربوط به polling را نگه می‌دارد. نسخهٔ جایگزین پس از تکمیل config، migration و Telegram initialization، Ready می‌شود و بدون خروج منتظر قفل می‌ماند. `SIGTERM` نسخهٔ قبلی polling را لغو و اتصال قفل را آزاد می‌کند تا نسخهٔ جدید takeover کند؛ در نتیجه فقط یک polling consumer فعال می‌ماند. قطع غیرمنتظرهٔ اتصال نگهدارندهٔ قفل نیز polling را abort می‌کند و shutdown کنترل‌شده با خروج ناموفق انجام می‌شود تا میزبان بتواند فرایند را جایگزین کند.

outbox قبل از فراخوانی Telegram به `SENDING` می‌رود. پاسخ موفق `SENT` است. شکست قطعی قابل retry به `PENDING` برمی‌گردد؛ شکست شبکه/5xx که نتیجه‌اش نامعلوم است `AMBIGUOUS` می‌شود. اگر process دقیقاً پس از تغییر به `SENDING` متوقف شود، همان وضعیت نیز برای بررسی انسانی حفظ می‌شود و کورکورانه ارسال مجدد نمی‌شود.

`APP_ENCRYPTION_KEY` کلید اصلی رمزگذاری outbox است. تغییر آن بدون برنامهٔ rotation، payloadهای ارسال‌نشده را غیرقابل‌خواندن می‌کند. `GEMINI_API_KEY` یک Secret مستقل و سراسری است و هرگز در PostgreSQL یا log نوشته نمی‌شود.

کانتینر هیچ volume برنامه‌ای ندارد. PostgreSQL خارج از کانتینر است. چون محصول فایل دائمی ندارد، S3 اضافه نشده است.
