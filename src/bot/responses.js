import { extraSeeds } from './response-style.js';
const errors = {
  BANK_SYNTAX:'قالب بانک درست نیست. نمونه: #DONGI bank create "سفر" 800000 سپس دو خط members: AB123*1 CD456*2 و manager: AB123. گزارش: #DONGI bank report B1. عملیات: #DONGI bank charge B1 100000 "دلیل"؛ به‌جای charge می‌توان refund یا spend نوشت.',
  BANK_GROUP_ONLY:'عملیات بانک فقط در گروهی انجام می‌شود که همهٔ اعضای بانک در آن حضور دارند.',
  BANK_MANAGER_REQUIRED:'مسئول بانک باید یکی از اعضای همان بانک باشد.',
  BANK_NOT_FOUND:'بانکی با این شناسه پیدا نشد؛ شناسه باید مانند B1 باشد.',
  BANK_DUPLICATE:'بانکی با همین اعضا، نسبت سهم‌ها و مسئول وجود دارد؛ بانک تازه ساخته نشد.',
  BANK_MEMBER_ABSENT:'همهٔ اعضای بانک باید در این گروه حضور داشته باشند؛ هیچ تغییری ثبت نشد.',
  BANK_MEMBER_INACTIVE:'عضو غیرفعال در بانک وجود دارد؛ تغییر مالی ثبت نشد.',
  BANK_INSUFFICIENT:'موجودی بانک برای این برگشت وجه یا خرج کافی نیست؛ چیزی ثبت نشد.',
  USER_ALREADY_LINKED:'این پروفایل قبلاً به تلگرام متصل شده؛ دعوت تازه صادر نشد.',
  INVITATION_REISSUED:'دعوت تازه به خصوصی رئیس فرستاده می‌شود؛ لینک‌های قبلیِ مصرف‌نشده باطل شدند.',
  INTERACTION_DISMISS:'حاضرم؛ برای حساب‌وکتاب با «هی دنگی» صدام کن، برای دستور دقیق با #DONGI.',
  OWNER_SUCCESS:'چشم رئیس؛ دستور انجام شد!',
  AI_PREVIEW_READY:'این‌طور فهمیدم؛ هنوز چیزی ثبت نشده. تا پنج دقیقه فرصت تأیید یا لغو داری:',
  AI_PREVIEW_CONFIRMED:'تأیید شد و در دفتر ثبت شد.',
  AI_PREVIEW_CANCELLED:'پیشنهاد لغو شد؛ چیزی ثبت نشد.',
  AI_CONFIRMATION_INVALID:'این دکمه برای این کاربر و گروه معتبر نیست.',
  AI_CONFIRMATION_USED:'این پیشنهاد قبلاً تعیین تکلیف شده؛ دوباره ثبت نمی‌شود.',
  AI_CONFIRMATION_EXPIRED:'مهلت پیشنهاد تمام شده؛ درخواستت را دوباره بفرست.',
  AI_PREVIEW_CHANGED:'اطلاعات یا تخصیص حساب از زمان پیش‌نمایش تغییر کرده؛ دوباره درخواست بده. چیزی ثبت نشد.',
  AI_INVALID_OUTPUT:'پیشنهاد هوش مصنوعی معتبر نبود؛ هیچ چیزی ثبت نشد.',
  AI_INVALID_INPUT:'درخواست بیش از حد طولانی یا نامعتبر است؛ چیزی ثبت نشد.',
  AI_PROVIDER_ERROR:'سرویس هوش مصنوعی پاسخ قابل استفاده نداد؛ چیزی ثبت نشد.',
  AI_RATE_LIMIT:'سهمیهٔ مدل فعلاً پر است؛ بعداً دوباره امتحان کن. چیزی ثبت نشد.',
  AI_MODELS_UNAVAILABLE:'مدل تأییدشده‌ای در دسترس نیست؛ چیزی ثبت نشد.',
  AI_CORE_TIMEOUT:'مهلت پاسخ هوش مصنوعی تمام شد؛ چیزی ثبت نشد.',
  AI_GATEWAY_BUSY:'سقف پنج درخواست هوش مصنوعی در دقیقه پر شده؛ چیزی ثبت نشد.',
  AI_ADMIN_REJECTED:'دستور مدیریتی فقط از مسیر #DONGI مجاز است؛ چیزی تغییر نکرد.',
  AI_CLARIFY:'درخواست مالی روشن نیست؛ مبلغ، پرداخت‌کننده و سهم افراد را دقیق بنویس.',
  AI_CHAT:'برای پیشنهاد مالی، مبلغ و سهم افراد را با «هی دنگی» بنویس؛ گفت‌وگوی آزاد هنوز آماده نیست.',
  PRIVATE_VIEW_READY:'اینم وضعیت خودت در دفتر دنگی:',
  PRIVATE_MENU_CLOSED:'منو بسته شد؛ برای بازکردنش /menu را بفرست.',
  PRIVATE_LIST_EMPTY:'اینجا فعلاً چیزی برای نمایش ندارم.',
  PRIVATE_HELP:'از دکمه‌ها حساب و ریزحساب‌هایت را ببین. فاکتورهای من یعنی فاکتورهایی که خودت ثبت کرده‌ای؛ تاریخچه رخدادهای مرتبط با تو را دارد. برای جزئیات: #DONGI details #184. تراز خصوصی سراسری است؛ در گروه #DONGI balance را برای تراز گروه‌های مشترک و #DONGI balance group را فقط برای فاکتورهای همان گروه بفرست.',
  OWNER_PROTECTED:'حساب Owner با این دستورها محدود نمی‌شود؛ چیزی تغییر نکرد.',
  USER_STATE_UNCHANGED:'این وضعیت از قبل برقرار است؛ تغییری انجام نشد.',
  USER_STATE_INVALID:'این تغییر با وضعیت فعلی سازگار نیست؛ برای حساب Suspended از user activate استفاده کن.',
  INVOICE_ALREADY_VOID: 'این فاکتور قبلاً باطل شده؛ تغییری انجام نشد.',
  INVOICE_NOT_VOID: 'این فاکتور باطل نیست؛ بازگردانی انجام نشد.',
  INVOICE_HAS_DEPENDENCIES: 'فاکتور تخصیص تسویه یا تهاتر دارد؛ تغییرش بدون بازسازی حساب‌ها امن نیست. هیچ تغییری انجام نشد.',
  NETTING_COMPLETED: 'طلب و بدهی‌های مقابل هم خودکار تهاتر شدند؛ پولی جابه‌جا نشد. ریزش در details ثبت شده.',
  NETTING_FAILED: 'تهاتر کامل نشد؛ کل ثبت مالی برگشت خورد و چیزی نیمه‌کاره نماند.',
  DETAILS_READY: 'اینم پروندهٔ فاکتور و ریز تخصیص‌ها:',
  INVOICE_NOT_FOUND: 'فاکتور یا رسید شناخته‌شده‌ای پیدا نکردم؛ شماره را بررسی کن.',
  INVOICE_CONTEXT_REQUIRED: 'شمارهٔ فاکتور را بنویس یا به رسید خودم Reply کن.',
  INVOICE_NOT_VISIBLE: 'همهٔ شرکت‌کنندگان این فاکتور عضو واجد شرایط این گروه نیستند؛ جزئیات اینجا نمایش داده نمی‌شود.',
  SETTLEMENT_CREATED: 'تسویه ثبت شد؛ هر دو سمت روی ریزحساب‌های باز اعمال شدند.',
  NO_OPEN_BALANCE: 'ریزحساب باز با جهت لازم پیدا نشد؛ هیچ تسویه‌ای ثبت نشد.',
  SETTLEMENT_EXCEEDS_OPEN_BALANCE: 'مبلغ تسویه بیشتر از ریزحساب باز یکی از دو سمت است؛ چیزی ثبت نشد.',
  SETTLEMENT_TARGET_INVALID: 'فاکتورهای انتخابی یا جهت تسویه معتبر نیستند یا پوشش کافی ندارند؛ چیزی ثبت نشد.',
  SETTLEMENT_ALLOCATION_FAILED: 'تخصیص تسویه کامل نشد؛ کل عملیات برگشت خورد.',
  REPORT_GROUP_ONLY: 'برای تراز و پیشنهاد تسویه، دستور را در همان گروه بفرست؛ چیزی تغییر نکرد.',
  BALANCE_READY: 'دفتر رو جمع زدم؛ اینم تراز گروه به تومان:',
  SETTLEMENT_PLAN_READY: 'با این انتقال‌ها می‌شه حساب رو جمع کرد؛ این فقط پیشنهاده و هیچ تسویه‌ای ثبت نشده:',
  NO_SETTLEMENT_NEEDED: 'حساب خالص گروه صفره؛ فعلاً تسویه‌ای لازم نیست. هیچ انتقالی ثبت نشده.',
  INVALID_ALIAS: 'نام مستعار باید معتبر و حداکثر ۲۰۰ نویسه باشد؛ me و all رزرو هستند. چیزی تغییر نکرد.',
  ALIAS_CONFLICT: 'این نام مستعار تکراری است یا با هویت فرد دیگری تداخل دارد؛ چیزی تغییر نکرد.',
  ALIAS_NOT_FOUND: 'این نام مستعار برای این فرد ثبت نشده؛ چیزی تغییر نکرد.',
  INVOICE_CREATED: 'ثبت شد؛ اینم رسیدش. عددها رو یه نگاه بنداز.',
  INVOICE_GROUP_ONLY: 'فاکتور رو داخل گروه ثبت کن تا عضویت همه بررسی بشه؛ چیزی ثبت نشد.',
  MEMBERSHIP_CHECK_FAILED: 'عضویت افراد با اطمینان بررسی نشد؛ دوباره تلاش کن. هیچ فاکتوری ثبت نشد.',
  USER_NOT_IN_GROUP: 'یکی از افراد فاکتور یا فرستنده عضو گروه نیست؛ هیچ فاکتوری ثبت نشد.',
  INVALID_AMOUNT: 'مبلغ معتبر نیست؛ عدد صحیح تومان بنویس. هیچ فاکتوری ثبت نشد.',
  INVALID_SHARE: 'وزن یا سهم معتبر نیست؛ سهم‌ها رو اصلاح کن. هیچ فاکتوری ثبت نشد.',
  SHARE_TOTAL_MISMATCH: 'جمع سهم‌های مبلغی با مبلغ فاکتور برابر نیست؛ هیچ فاکتوری ثبت نشد.',
  PERCENTAGE_TOTAL_INVALID: 'جمع درصدها باید دقیقاً ۱۰۰ باشد؛ هیچ فاکتوری ثبت نشد.',
  UNKNOWN_USER: 'یکی از نام‌ها شناخته نشد؛ نام دقیق یا شناسه را وارد کن. هیچ فاکتوری ثبت نشد.',
  AMBIGUOUS_USER: 'یکی از نام‌ها به چند نفر می‌خورد؛ شناسهٔ دقیق را وارد کن. هیچ فاکتوری ثبت نشد.',
  DUPLICATE_PARTICIPANT: 'یک نفر در یک سمت فاکتور چند بار آمده؛ تکرار را حذف کن. هیچ فاکتوری ثبت نشد.',
  ZERO_SUM_FAILED: 'جمع مثبت و منفی فاکتور صفر نیست؛ مبلغ‌ها را اصلاح کن. هیچ فاکتوری ثبت نشد.',
  PERMISSION_DENIED: 'دستور رو فهمیدم؛ اختیار اجراش رو نداری.',
  ADMIN_DETERMINISTIC_ONLY: 'دستور مدیریتی فقط با #DONGI اجرا می‌شه؛ چیزی تغییر نکرد.',
  USER_NOT_STARTED: 'کاربر موردنیاز هنوز در خصوصی Start نکرده؛ چیزی ثبت نشد.',
  ACTOR_FROZEN: 'حسابت Frozen ـه و اجازهٔ اجرای این دستور رو نداری.',
  TARGET_SUSPENDED: 'حساب فرد موردنظر غیرفعاله؛ عملیات انجام نشد.',
  INVALID_PUBLIC_ID: 'شناسه باید دو حرف بزرگ انگلیسی و عدد ۱۰۰ تا ۹۹۹ باشه؛ مثل AB417. چیزی ثبت نشد.',
  PUBLIC_ID_CONFLICT: 'این شناسه قبلاً گرفته شده؛ یکی دیگه انتخاب کن. پروفایل جدید ثبت نشد.',
  PUBLIC_ID_ALLOCATION_FAILED: 'شناسهٔ آزاد پیدا نشد؛ ایجاد پروفایل انجام نشد.',
  INVALID_USER_NAME: 'نام معتبر رو داخل گیومه بنویس؛ چیزی ثبت نشد.',
  USER_NAME_CONFLICT: 'این نام قبلاً گرفته شده یا رزرو است؛ نام دیگری انتخاب کن.',
  INVALID_TELEGRAM_ID: 'شناسهٔ تلگرام معتبر نیست؛ چیزی تغییر نکرد.',
  TELEGRAM_ID_CONFLICT: 'این حساب یا پروفایل قبلاً متصل شده؛ اتصال جدید انجام نشد.',
  ONBOARDING_PRIVATE_ONLY: 'برای اتصال حساب، لینک دعوت رو در خصوصی خودم باز کن.',
  ONBOARDING_TOKEN_INVALID: 'این دعوت معتبر نیست یا مهلتش تمام شده؛ از رئیس دعوت تازه بگیر.',
  UNKNOWN_COMMAND: 'این دستور رو هنوز بلد نیستم. #DONGI help رو ببین؛ چیزی تغییر نکرد.',
  PARSE_FAILED: 'فهمیدم با منی، ولی قالب دستور درست نیست. #DONGI help رو ببین؛ چیزی ثبت نشد.',
  FEATURE_UNAVAILABLE: 'این بخش هنوز آماده نیست؛ هیچ عملیات مالی یا مدیریتی انجام نشد.',
  ONBOARDING_REQUIRED: 'برای آشنایی اول باید رئیس برات پروفایل بسازه و لینک دعوت بده.',
  DUPLICATE_REQUEST: 'این پیام قبلاً پردازش شده؛ دوباره اجراش نکردم.',
  DB_TRANSACTION_FAILED: 'ذخیره‌سازی شکست خورد و کل عملیات Rollback شد.\nTrace: {{trace_id}}',
  INTERNAL_ERROR: 'پردازش به مشکل خورد؛ این درخواست اعمال نشد.\nTrace: {{trace_id}}',
};

export const catalog = {
  USER_FROZEN:{variables:['name','public_id','scope'],templates:['{{name}} [{{public_id}}] فریز شد. دامنه: {{scope}}. سابقه و امکان حضور در فاکتور حفظ شد.']},
  USER_UNFROZEN:{variables:['name','public_id','scope'],templates:['فریز {{name}} [{{public_id}}] برداشته شد. دامنه: {{scope}}. محدودیت‌های دامنه‌های دیگر مستقل‌اند.']},
  USER_SUSPENDED:{variables:['name','public_id','scope'],templates:['{{name}} [{{public_id}}] غیرفعال شد. دامنه: {{scope}}. سابقه‌ها محفوظ‌اند.']},
  USER_ACTIVATED:{variables:['name','public_id','scope'],templates:['{{name}} [{{public_id}}] فعال شد. دامنه: {{scope}}. فریزهای محلی مستقل‌اند.']},
  INVOICE_VOIDED: {variables:['invoice_ref'],templates:['{{invoice_ref}} از حساب جاری خارج شد؛ ریزحساب و تاریخچه سر جاشه.']},
  INVOICE_RESTORED: {variables:['invoice_ref'],templates:['{{invoice_ref}} دوباره وارد حساب شد؛ ریزحساب‌های باز هم بررسی شدند.']},
  ALIAS_ADDED: { variables: ['alias', 'name', 'public_id'], templates: ['ثبت شد؛ {{alias}} هم شد یکی از اسم‌های {{name}} [{{public_id}}].'] },
  ALIAS_REMOVED: { variables: ['alias', 'name', 'public_id'], templates: ['{{alias}} از اسم‌های {{name}} [{{public_id}}] حذف شد؛ سوابق سر جاشه.'] },
  ...Object.fromEntries(Object.entries(errors).map(([key, template]) => [key, {
    variables: template.includes('{{trace_id}}') ? ['trace_id'] : [], templates: [template],
  }])),
  HELP: { variables: [], templates: ['دستورهای آماده:\n/start در خصوصی: پروفایل\n#DONGI help: راهنما\n#DONGI user create "نام" [AB417]: فقط رئیس\n#DONGI alias AB417 add ممد: فقط رئیس\nفاکتور گروه:\n#DONGI invoice "غذا" 600000\nbetween: me AB417\n#DONGI balance: تراز گروه‌های مشترک با اعضای گروه فعلی\n#DONGI balance group: فقط فاکتورهای ثبت‌شده در همین گروه\n#DONGI settle-plan: پیشنهاد تسویه\nتسویه از طرف خودت:\n#DONGI settle 100000\nto: AB417'] },
  PROFILE: { variables: ['name', 'public_id', 'status'], templates: ['اینم شناسنامه‌ات پیش من:\n{{name}} [{{public_id}}]\nوضعیت: {{status}}'] },
  USER_CREATED: { variables: ['name', 'public_id'], templates: ['{{name}} [{{public_id}}] رفت توی دفتر آدم‌ها. دعوت رو توی خصوصی رئیس می‌فرستم.'] },
  USER_INVITATION: { variables: ['name', 'public_id', 'link', 'expires'], templates: ['دعوت {{name}} [{{public_id}}]:\n{{link}}\nاعتبار تا: {{expires}}\nاین لینک فقط برای خود اون آدمه؛ به خودش برسون.'] },
};

catalog.REQUEST_TIMEOUT={variables:[],templates:['مهلت رسیدگی به درخواست تمام شد؛ نتیجهٔ مالی تازه‌ای از این درخواست ثبت نشد. دوباره با اطلاعات روشن امتحان کن.']};

export function validTemplate(event, template) {
  const spec = catalog[event];
  if (!spec || typeof template !== 'string' || !template.trim() || template.length > 3000) return false;
  const matches = [...template.matchAll(/\{\{([a-z_]+)\}\}/g)];
  const names = new Set(matches.map(match => match[1]));
  return !/[{}]/.test(template.replace(/\{\{[a-z_]+\}\}/g, ''))
    && [...names].every(name => spec.variables.includes(name))
    && spec.variables.every(name => names.has(name));
}
catalog.HELP.templates=['دستورهای دنگی:\n#DONGI help: راهنما\n/start و /my در خصوصی: حساب و پروفایل\n#DONGI user create "نام": ساخت پروفایل، فقط Owner\n#DONGI user invite AB417: دعوت تازه، فقط Owner\n#DONGI alias AB417 add ممد: نام مستعار، Owner یا ادمین گروه\n#DONGI invoice "غذا" 600\nbetween: me AB417\n#DONGI balance: تراز گروه‌های مشترک با اعضای گروه فعلی\n#DONGI balance group: فقط فاکتورهای ثبت‌شده در همین گروه\n#DONGI settle-plan: پیشنهاد تسویه\n#DONGI settle 100\nto: AB417\n#DONGI details #184: جزئیات\n#DONGI void #184 / #DONGI restore #184: ابطال/بازگردانی\n#DONGI freeze AB417 / #DONGI unfreeze AB417: محدودیت\nهی دنگی + درخواست مالی: پیش‌نمایش و تأیید\nبانک: #DONGI bank report B1؛ قالب ساخت و شارژ در راهنمای نسخه.\nهی دنگی با #exact در انتها: بدون حدس مقیاس مبلغ.\nخصوصی: /my banks برای بانک‌های من.\nبرای گپ به پیام من Reply کن؛ گاهی جواب کوتاه می‌دهم. شناسه‌ها و شماره‌ها نمونه‌اند.'];

for(const [event,templates] of Object.entries(extraSeeds)) {
  if(catalog[event])catalog[event].templates.push(...templates);
}
export function seedResponses(db) {
  db.prepare("UPDATE response_pool SET enabled=0 WHERE event_key='HELP' AND source='SEED' AND template<>?").run(catalog.HELP.templates[0]);
  db.prepare("UPDATE response_pool SET enabled = 0 WHERE event_key = 'HELP' AND source = 'SEED' AND template LIKE '%ثبت تسویه هنوز آماده نیست.%'").run();
  db.prepare("UPDATE response_pool SET enabled = 0 WHERE event_key = 'HELP' AND source = 'SEED' AND template LIKE '%تسویه و تراز هنوز آماده نیستند.%'").run();
  db.prepare("UPDATE response_pool SET enabled = 0 WHERE source = 'SEED' AND (template = ? OR template = ?)")
    .run('اول توی خصوصی Start کن تا بشناسمت؛ چیزی ثبت نشد.', 'این حساب غیرفعاله؛ اتصال انجام نشد.');
  db.prepare("UPDATE response_pool SET enabled = 0 WHERE event_key = 'HELP' AND source = 'SEED' AND template LIKE '%حسابداری هنوز فعال نشده.%'").run();
  const insert = db.prepare('INSERT OR IGNORE INTO response_pool(event_key, template, created_at) VALUES (?, ?, ?)');
  const insertRole=db.prepare('INSERT OR IGNORE INTO response_pool(event_key,actor_role,template,created_at) VALUES (?,?,?,?)');
  for (const [event, spec] of Object.entries(catalog)) {
    for (const template of spec.templates) insert.run(event, template, Date.now());
    if(['INVOICE_CREATED','SETTLEMENT_CREATED'].includes(event))for(const role of ['OWNER','MEMBER','ADMIN'])for(const template of spec.templates)insertRole.run(event,role,template,Date.now());
  }
}
// Only intentionally public domain facts are rendered; never dump arbitrary error objects.
export function errorDetails(details = {}) {
  const labels = { addressed_as: 'نام ورودی', public_id: 'شناسه', candidates: 'گزینه‌ها', raw_amount: 'مقدار ورودی',
    expected: 'مقدار لازم', actual: 'مقدار محاسبه‌شده', difference: 'اختلاف جمع (تومان)' };
  return Object.entries(labels).filter(([key]) => typeof details[key] === 'string')
    .map(([key, label]) => `${label}: ${details[key].replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 250)}`).join('\n');
}
export function renderResponse(db, event, variables = {}, role = 'GENERAL', random = Math.random) {
  const spec = catalog[event];
  if (!spec) throw new Error('Unknown response event');
  for (const name of spec.variables) {
    if (typeof variables[name] !== 'string') throw new Error('Missing response variable');
  }
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM response_pool WHERE event_key = ? AND enabled = 1 AND actor_role IN (?, ?)')
      .all(event, role, 'GENERAL').filter(row => validTemplate(event, row.template));
  } catch { /* Bundled seed remains available even during a DB failure. */ }
  const specific = rows.filter(row => row.actor_role === role);
  if (specific.length) rows = specific;
  let selected;
  if (rows.length) {
    let weight = random() * rows.reduce((sum, row) => sum + row.weight, 0);
    selected = rows.find(row => (weight -= row.weight) < 0) ?? rows[0];
  }
  const template = selected?.template ?? spec.templates[0];
  if (selected) {
    try { db.prepare('UPDATE response_pool SET usage_count = usage_count + 1 WHERE id = ?').run(selected.id); } catch { /* best effort metric */ }
  }
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => variables[name]);
}
