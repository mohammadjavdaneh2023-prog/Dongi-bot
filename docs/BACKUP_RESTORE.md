# بکاپ و Restore

`scripts/backup.sh` از `pg_dump --format=custom` استفاده و خروجی را با AES-256-CBC/PBKDF2 رمزگذاری می‌کند. `BACKUP_ENCRYPTION_KEY` باید مستقل از `APP_ENCRYPTION_KEY` و خارج از Git نگهداری شود.

```sh
DATABASE_URL=... BACKUP_ENCRYPTION_KEY=... BACKUP_OUTPUT=/secure/path ./scripts/backup.sh
```

فایل رمزگذاری‌شده را بعداً می‌توان به bucket/prefix اختصاصی DONGI در Object Storage منتقل کرد. credential آن bucket باید فقط به همان prefix دسترسی داشته باشد. Repository و filesystem کانتینر محل بکاپ نیستند.

Restore فقط به دیتابیس خالی انجام می‌شود:

```sh
RESTORE_DATABASE_URL=... BACKUP_ENCRYPTION_KEY=... ./scripts/restore.sh /secure/path/dongi-TIMESTAMP.dump.enc
```

اسکریپت خالی‌بودن target را بررسی، Restore را single-transaction اجرا و وجود نسخه‌های migration را چاپ می‌کند. پس از آن تعداد جداول/رکوردهای کلیدی، `/readyz` و یک آزمون خواندنی کنترل‌شده را بررسی کنید؛ Bot production را تا پایان بررسی متوقف نگه دارید.

Retention پیشنهادی: ۱۴ نسخهٔ روزانه، ۸ نسخهٔ هفتگی و ۱۲ نسخهٔ ماهانه. حداقل ماهانه یک Restore در محیط جدا آزمایش و نتیجه ثبت شود. حذف نسخه‌ها باید فقط پس از تأیید وجود نسخه‌های سالم جدید انجام شود. بکاپ میزبان تنها نسخهٔ قابل‌اعتماد نیست.
