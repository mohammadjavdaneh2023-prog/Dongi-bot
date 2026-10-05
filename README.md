# DONGI

DONGI یک Bot حسابداری گروهی تلگرام برای فاکتور، تسویه، تهاتر خودکار، تراز، بانک مشترک و داشبورد خصوصی است. نام فنی و slug محصول `dongi` است.

این Repository از صفر و بدون دادهٔ نسخهٔ قبلی شروع می‌شود. PostgreSQL تنها محل دادهٔ پایدار است؛ کانتینر برنامه stateless است و فایل دائمی تولید نمی‌کند، بنابراین Object Storage در نسخهٔ فعلی لازم نیست.

## قابلیت‌ها

- ثبت فاکتور قطعی با سهم مساوی، وزنی، درصدی، مبلغ دقیق یا دفتر مستقیم
- ثبت تسویه، تخصیص به مانده‌های باز و تهاتر خودکار
- جزئیات، ابطال و بازگردانی کنترل‌شدهٔ فاکتور
- تراز گروه و پیشنهاد تسویه بدون ثبت عملیات مالی
- بانک مشترک با اعضا/وزن ثابت، شارژ، برگشت، خرج و گزارش
- Owner، دعوت یک‌بارمصرف، Alias، نقش Admin تلگرام، Freeze و Suspend
- داشبورد خصوصی، تاریخچه و گزارش‌های شخصی
- پیشنهاد مالی AI با تأیید صریح و یک API Key داخلی سراسری
- idempotency برای Updateها و عملیات مالی، outbox پایدار و توقف retry در وضعیت ارسال مبهم

جزئیات رفتار و مسیرهای کاربر در [رفتار محصول](docs/PRODUCT_BEHAVIOR.md) آمده است.

## اجرای محلی با Docker

پیش‌نیاز: Docker با Compose.

```sh
cp .env.example .env
# مقادیر محلی لازم را در .env وارد کنید.
docker compose up --build postgres
docker compose run --rm app npm run migrate
docker compose run --rm app npm run bootstrap-owner
docker compose up --build app
```

برای اجرای بدون Docker، Node.js دقیقاً سری 24 و یک PostgreSQL در دسترس لازم است:

```sh
npm ci
cp .env.example .env
npm run migrate
npm run bootstrap-owner
npm start
```

دیتابیس باید برای این محصول database و user مستقل با کمترین دسترسی لازم داشته باشد. اجرای migration روی PostgreSQL خالی تمام schema را می‌سازد؛ هیچ import از SQLite وجود ندارد.

## تست و بررسی

```sh
npm ci
npm run check
npm run format:check
npm run verify:secrets
npm run test:unit
TEST_DATABASE_URL=postgresql://... npm test
docker build -t dongi:local .
```

تست کامل به PostgreSQL واقعی و قابل‌حذف نیاز دارد. تست‌ها درخواست واقعی به Telegram یا Gemini نمی‌فرستند و از secret واقعی استفاده نمی‌کنند.

## Health و نسخه

- `GET /healthz`: زنده‌بودن process
- `GET /readyz`: آماده‌بودن برنامه، PostgreSQL، migration و Telegram initialization
- `GET /version`: مقدار غیرمحرمانهٔ `APP_VERSION`

پورت پیش‌فرض `3000` است. Startup ابتدا migration را تراکنشی اجرا می‌کند و فقط بعد از آماده‌شدن Telegram، `/readyz` پاسخ `200` می‌دهد. هنگام انتشار rolling، نسخهٔ جدید در همین وضعیت Ready منتظر advisory lock اختصاصی polling می‌ماند؛ پس از توقف نسخهٔ قبلی قفل را می‌گیرد و polling را آغاز می‌کند، بدون اینکه دو مصرف‌کننده هم‌زمان فعال شوند.

## تنظیمات

تنها فایل نمونهٔ قابل Commit، `.env.example` است. Secretها در Git، image یا log قرار نمی‌گیرند. متغیرهای لازم:

- مشترک: `APP_ENV`, `APP_VERSION`, `DATABASE_URL`, `LOG_LEVEL`, `PORT`, `DEFAULT_TIMEZONE`, `APP_ENCRYPTION_KEY`, `GEMINI_API_KEY`
- Telegram و bootstrap: `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `OWNER_NAME`, `OWNER_PUBLIC_ID`, `DONGI_GRANT_TTL_SECONDS`
- تست: `TEST_DATABASE_URL`
- ابزار بکاپ: `BACKUP_ENCRYPTION_KEY`, `BACKUP_OUTPUT`, `RESTORE_DATABASE_URL`

`DONGI_GRANT_TTL_SECONDS` برای دعوت کاربران دقیقاً `3600` است؛ مقدار دیگری باعث توقف startup می‌شود. `GEMINI_API_KEY` کلید داخلی و مشترک کل زیرسیستم AI است. فقط مالک سیستم آن را در Secretهای میزبان وارد می‌کند؛ کاربران هیچ کلیدی ثبت یا مدیریت نمی‌کنند. این کلید در PostgreSQL، Git، image یا log ذخیره نمی‌شود.

## عملیات و انتشار آینده

- [معماری و داده‌ها](docs/ARCHITECTURE.md)
- [راهنمای عملیات، migration و rollback](docs/OPERATIONS.md)
- [بکاپ و Restore](docs/BACKUP_RESTORE.md)
- [آماده‌سازی Darkube c23](docs/DARKUBE.md)

روند انتشار آینده: Branch جدا → Pull Request → CI موفق → تأیید مالک → merge به `main` → انتشار خودکار Darkube. پس از اولین Push باید Ruleset یا Branch Protection برای منع direct/force push و الزام PR و check اصلی CI فعال شود. هیچ remote یا Deploy در این آماده‌سازی ساخته نشده است.
