# معماری

DONGI یک process Node.js 24 با سه مرز اصلی است: Telegram adapter، منطق دامنه و PostgreSQL. parserها و قواعد مالی pure باقی مانده‌اند. Repositoryها از یک facade همگام استفاده می‌کنند که queryهای PostgreSQL را در Worker اجرا می‌کند؛ این انتخاب تراکنش‌های کوتاه و رفتار دامنهٔ موجود را حفظ کرده و مهاجرت پرریسک کل برنامه به async را حذف کرده است. این facade برای throughput یک Replica طراحی شده و در مقیاس بالاتر باید اندازه‌گیری شود.

Startup migrationها را زیر advisory lock و در تراکنش اجرا می‌کند. migration اعمال‌شده ویرایش نمی‌شود؛ تغییر بعدی فایل شماره‌دار جدید می‌گیرد. `schema_migrations` نسخه‌ها را ثبت می‌کند.

قفل advisory دوم تضمین می‌کند فقط یک polling consumer فعال باشد. `SIGTERM` دریافت polling را لغو می‌کند، Health را Not Ready می‌کند، HTTP server را می‌بندد و اتصال DB را آزاد می‌کند.

outbox قبل از فراخوانی Telegram به `SENDING` می‌رود. پاسخ موفق `SENT` است. شکست قطعی قابل retry به `PENDING` برمی‌گردد؛ شکست شبکه/5xx که نتیجه‌اش نامعلوم است `AMBIGUOUS` می‌شود. اگر process دقیقاً پس از تغییر به `SENDING` متوقف شود، همان وضعیت نیز برای بررسی انسانی حفظ می‌شود و کورکورانه ارسال مجدد نمی‌شود.

`APP_ENCRYPTION_KEY` کلید اصلی رمزگذاری outbox است. تغییر آن بدون برنامهٔ rotation، payloadهای ارسال‌نشده را غیرقابل‌خواندن می‌کند. `GEMINI_API_KEY` یک Secret مستقل و سراسری است و هرگز در PostgreSQL یا log نوشته نمی‌شود.

کانتینر هیچ volume برنامه‌ای ندارد. PostgreSQL خارج از کانتینر است. چون محصول فایل دائمی ندارد، S3 اضافه نشده است.
