export const ownerSuccessEvents = new Set([
 'INVOICE_CREATED','SETTLEMENT_CREATED','INVOICE_VOIDED','INVOICE_RESTORED',
 'USER_CREATED','ALIAS_ADDED','ALIAS_REMOVED','USER_FROZEN','USER_UNFROZEN',
 'USER_SUSPENDED','USER_ACTIVATED','BALANCE_READY','SETTLEMENT_PLAN_READY','NO_SETTLEMENT_NEEDED','DETAILS_READY',
]);

export function ownerDecoration({event,role,deterministic,hasPayload=true,random=Math.random}) {
 return role==='OWNER'&&deterministic&&ownerSuccessEvents.has(event)&&(!hasPayload||random()<0.5);
}

export const extraSeeds = {
 OWNER_SUCCESS:['چشم رئیس؛ دفتر هم با فرمان شما خبردار ایستاد!','امر شما اجرا شد رئیس؛ حساب‌ها هم تعظیم کردن!','رئیس، دستور انجام شد؛ حساب‌وکتابش هم سر جاشه.'],
 INVOICE_CREATED:['ثبت شد؛ دنگ‌ها رفتن سر جای خودشون. اینم رسید:','فاکتور نشست توی دفتر؛ ریز حسابش این پایین است:'],
 SETTLEMENT_CREATED:['تسویه ثبت شد؛ ریزحساب‌های هر دو طرف به‌روز شدند.','این پرداخت رفت توی دفتر؛ تخصیص تسویهٔ هر دو سمت انجام شد.'],
 AI_PREVIEW_READY:['این برداشت منه؛ هنوز ثبتش نکردم. تا پنج دقیقه می‌تونی تأیید یا لغوش کنی:'],
 AI_PREVIEW_CANCELLED:['پیشنهاد کنار رفت؛ هیچ حسابی تغییر نکرد.'],
 AI_CONFIRMATION_EXPIRED:['وقت این پیشنهاد تموم شد؛ دوباره درخواست بده تا حساب تازه رو ببینیم.'],
 AI_INVALID_OUTPUT:['جواب مدل اعتبارسنجی رو نگذروند؛ چیزی توی دفتر ننوشتم.'],
 AI_PROVIDER_ERROR:['مدل جواب قابل استفاده نداد؛ دفترت دست‌نخورده موند.'],
 AI_GATEWAY_BUSY:['پنج درخواست این دقیقه پر شده؛ درخواستت به مدل نرفت و چیزی ثبت نشد.'],
 DUPLICATE_REQUEST:['این درخواست قبلاً رسیدگی شده؛ اثرش رو دوباره روی حساب نمی‌اندازم.'],
 PERMISSION_DENIED:['این کار با دسترسی فعلی تو مجاز نیست؛ چیزی تغییر نکرد.'],
 UNKNOWN_USER:['این اسم رو توی دفتر آدم‌ها پیدا نکردم؛ نام دقیق یا شناسه رو بفرست.'],
 PARSE_FAILED:['قالب دستور جور درنیومد؛ #DONGI help رو ببین. چیزی ثبت نشد.'],
};
