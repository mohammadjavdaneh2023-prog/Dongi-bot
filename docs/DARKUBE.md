# آماده‌سازی Darkube — کلاستر آلمان c23

- مسیر build: `Dockerfile`
- پورت: `3000` یا مقدار `PORT`
- Liveness: `/healthz`
- Readiness: `/readyz`
- Replica اولیه: `1`
- Start: `node scripts/start.js`
- Migration: `node scripts/migrate.js` پیش از شروع release؛ Startup نیز migration را بررسی می‌کند.
- PostgreSQL: سرویس خارجی با database/user/password مستقل DONGI
- volume برنامه: هیچ‌کدام

Secretهای `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `OWNER_NAME` فقط در کنسول میزبان وارد شوند. `APP_VERSION` را برابر SHA یا tag تصویر قرار دهید. `APP_ENV=production`, `LOG_LEVEL=INFO`, `DEFAULT_TIMEZONE=Asia/Tehran` و `PORT=3000` تنظیم شوند.

Owner bootstrap یک عملیات یک‌باره پس از ساخت دیتابیس خالی است. `OWNER_*` پس از bootstrap می‌تواند از runtime حذف شود. `GEMINI_API_KEY` یک Secret داخلی مشترک است و کاربران آن را نمی‌بینند یا مدیریت نمی‌کنند.

اکنون هیچ حساب، Service، PostgreSQL، Object Storage یا Deploy در Darkube ساخته نشده است. انتخاب cluster `c23` و اتصال GitHub در مرحلهٔ آینده و فقط با اجازهٔ مالک انجام می‌شود.
