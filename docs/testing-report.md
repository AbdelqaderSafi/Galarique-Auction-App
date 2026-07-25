# تقرير الاختبار (Testing Report) — GalleryQ Backend

**التاريخ:** 2026-07-25
**النطاق:** Unit Testing، Integration Testing، System Testing (تم تأجيل/تخطي User Acceptance Testing بقرار صاحب المشروع، لأنه يحتاج مستخدمين حقيقيين وواجهة موبايل جاهزة — خارج نطاق هذه المرحلة).

---

## 1. الخلاصة التنفيذية

تم بناء وتشغيل ثلاثة مستويات اختبار كاملة فوق الـ backend (NestJS 11 + Prisma 7 + PostgreSQL):

| المستوى | الأداة | عدد الاختبارات | النتيجة |
|---|---|---|---|
| **Unit Testing** | Jest + `jest-mock-extended` (Prisma مُموَّه بالكامل) | 14 test suite / **139 test** | ✅ 139/139 ناجحة |
| **Integration Testing** | Jest + Supertest + قاعدة بيانات PostgreSQL محلية حقيقية (`galleryq_test`) | 1 test suite / **8 test** (تدفّق كامل عبر 6 مراحل) | ✅ 8/8 ناجحة |
| **System Testing** | سيرفر Nest حقيقي (`node dist/src/main.js`) + قاعدة بيانات معزولة (`galleryq_system_test`) + ImageKit/Stripe test-mode حقيقيين | 6 سكربتات، **184 تحقّق (assertion)** عبر 12 خطوة | ✅ 184/184 ناجحة، 12/12 خطوة |
| **User Acceptance Testing** | — | — | ⏭️ متخطّى بقرار صريح (يحتاج مستخدمين حقيقيين/فريق الموبايل) |

**النتيجة العامة: لا توجد أي مشكلة مكتشفة في المنطق الحالي للمشروع** عبر الثلاث مستويات. كل تدفقات العمل الحرجة (auth، auctions wizard، bids + deposits، wallet + Stripe، orders + settlement، seller verification، favorites/follows) تم التحقق منها فعليًا وليس نظريًا فقط.

---

## 2. Unit Testing (اختبار الوحدات)

**الهدف:** اختبار منطق كل `*.service.ts` بمعزل تام عن قاعدة البيانات والخدمات الخارجية (Prisma مُموَّه بالكامل عبر `jest-mock-extended`؛ انظر `src/test-utils/prisma-mock.ts`).

**التشغيل:** `npm test` (أو `npm run test:cov` للتغطية).

### الموديولات المغطاة (14 ملف spec، 139 اختبار)

| الموديول | الملف | أبرز الحالات المختبرة |
|---|---|---|
| `bids` | `bids.service.spec.ts` | أول مزايدة ≥ `startingPrice`، مزايدة لاحقة ≥ `currentPrice+minBidIncrement`، حجز/تحرير وديعة 50$، anti-snipe، رفض المالك/الفائز الحالي/رصيد غير كافٍ |
| `wallet` | `wallet.service.spec.ts` | حجز/تحرير الوديعة، top-up عبر Stripe Checkout، idempotency لحدث Stripe webhook، سحب عبر Stripe Connect |
| `orders` | `orders.service.spec.ts` | `payOrder()` الموحّد (خصم مضمون ذريًا، تطبيق الوديعة، استرجاع الفائض، تعويض البائع فورًا) |
| `orders` (scheduler) | `settlement.service.spec.ts` | إغلاق المزادات المستحقة، انتهاء مهلة الدفع، إعادة محاولة الدفع، تحويل الفرصة للمزايد الثاني |
| `auth` | `auth.service.spec.ts` | تسجيل مع تحقق بريد بكود، تسجيل دخول، نسيان/إعادة تعيين كلمة السر، تغيير كلمة السر، مصادقة Google |
| `auctions` | `auctions.service.spec.ts` | إنشاء (Object+Auction بمعاملة واحدة)، تعديل، حذف draft، submit/cancel، موافقة/رفض الأدمن، إعادة الإرسال التلقائي بعد التعديل |
| `categories` | `categories.service.spec.ts` | إرجاع قائمة enum الثابتة |
| `favorites` | `favorites.service.spec.ts` | إضافة/إزالة/سرد المفضلة (idempotent، فقط للمزادات العامة) |
| `favorites` (follows) | `follows.service.spec.ts` | متابعة/إلغاء متابعة بائع، منع متابعة النفس |
| `user` | `user.service.spec.ts` | تحديث الملف الشخصي، تعارض اسم مستخدم مكرر (409 عبر Prisma P2002) |
| `seller-verification` | `seller-verification.service.spec.ts` | إرسال/إعادة إرسال/تحقق OTP، إنشاء `SellerProfile` ومنح دور `SELLER` |
| `seller-verification` (util) | `phone.util.spec.ts` | تطبيع رقم الهاتف الفلسطيني (+970/+972) |
| `realtime` | `realtime.service.spec.ts` (موجود مسبقًا) | نشر أحداث SSE |
| `app` | `app.controller.spec.ts` (boilerplate) | — |

### تغطية الكود (coverage) لملفات الـ services الأساسية

| الملف | Statements | Branches | Functions |
|---|---|---|---|
| `bids.service.ts` | 100% | 84.6% | 100% |
| `auctions.service.ts` | 87.2% | 81.5% | 81% |
| `orders.service.ts` | 84.9% | 73.6% | 54.5% |
| `settlement.service.ts` | 96.7% | 83.6% | 100% |
| `favorites.service.ts` / `follows.service.ts` | 100% | ~82% | 100% |
| `categories.service.ts` | 100% | 100% | 100% |
| `auth.service.ts` | 64.2% | 61% | 75% |
| `seller-verification.service.ts` | 82.4% | 70.5% | 88.9% |
| `wallet.service.ts` | 63.7% | 53.6% | 55.6% |
| `user.service.ts` | 81.8% | 50% | 57.1% |

**ملاحظة:** التغطية الإجمالية على كل الملفات (controllers/DTOs/swagger/`main.ts`/`mail.service.ts`/`uploads.service.ts`/`stripe.service.ts`/`whatsapp.service.ts`) حوالي 37% لأن هذه الملفات إما نقاط دخول HTTP (مغطاة فعليًا بواسطة Integration وSystem Testing وليس Unit) أو أغلفة رقيقة حول خدمات خارجية (Stripe SDK، ImageKit SDK، Baileys) تم اختبار سلوكها الفعلي عبر System Testing بمفاتيح test-mode حقيقية بدل تمويهها بالكامل في Unit — قرار متعمد لتفادي ازدواجية الجهد.

---

## 3. Integration Testing (اختبار التكامل)

**الهدف:** التحقق من أن الموديولات تتكامل بشكل صحيح فعليًا عبر HTTP حقيقي (Supertest) فوق قاعدة بيانات PostgreSQL محلية حقيقية (`galleryq_test`) — لا Prisma مموَّه هنا. فقط الخدمات الخارجية الحقيقية (ImageKit، Stripe) مموَّهة (انظر `test/integration/test-app.ts`) لأنها تحتاج شبكة/مفاتيح خارجية حقيقية.

**التشغيل:** `npm run test:integration` (يستخدم `.env.test`، قاعدة بيانات معزولة تمامًا عن Neon).

**السيناريو المختبر** (`test/integration/auction-lifecycle.integration-spec.ts`، 8 اختبارات) يغطي تدفقًا متكاملًا بين 6 موديولات بالتسلسل:

1. **Auth:** تسجيل → تحقق بريد بكود (ملتقط من `capturedMail` الوهمي) → تسجيل دخول.
2. **Seller verification:** طلب OTP → تحقق → إنشاء `SellerProfile` ومنح دور `SELLER`.
3. **Auctions:** إنشاء مزاد (Object+Auction بمعاملة واحدة، رفع صورة عبر ImageKit المموَّه) → موافقة الأدمن → ظهوره في التصفح العام.
4. **Bids:** مزايدة أولى وثانية عبر مستخدمين مختلفين، التحقق من حجز/تحرير الوديعة 50$ في المحفظة.
5. **Orders/Settlement:** تشغيل الجدولة الإدارية (`POST /scheduler/run`) لإغلاق المزاد المنتهي، إنشاء `Order`، ودفع الفائز (`payOrder`).
6. **Wallet:** التحقق من أرصدة `balance`/`lockedBalance` والـ `WalletTransaction` بعد كامل التدفق.

**النتيجة:** ✅ 8/8 اختبارات ناجحة — يثبت أن الطبقات (auth → seller-verification → auctions → bids → wallet → orders/settlement) تعمل معًا بشكل صحيح على معاملات DB حقيقية، وليس فقط بمعزل كما في Unit Testing.

---

## 4. System Testing (اختبار النظام الكامل)

**الهدف:** اختبار "صندوق أسود" (black-box) للنظام الكامل كما سيستخدمه تطبيق الموبايل فعليًا — سيرفر Nest حقيقي يعمل (`node dist/src/main.js`)، قاعدة بيانات PostgreSQL محلية معزولة تمامًا (`galleryq_system_test`, منفصلة عن Neon dev/production)، ورفع صور فعلي إلى ImageKit + عمليات Stripe test-mode حقيقية (بدون تحريك أموال حقيقية).

**الإعداد:** `.env.system-test` (منفذ 3100، `SELLER_OTP_SIMULATE=true` لتفادي الحاجة لواتساب حقيقي، `BREVO_API_KEY` فارغ عمدًا فيُطبع الكود بدل الإرسال والسكربتات تلتقطه من لوق السيرفر).

**طريقة التشغيل:**
```bash
npm run build
$env:DOTENV_CONFIG_PATH=".env.system-test"; node -r dotenv/config dist/src/main.js *> system-test-server.log &
node scripts/run-system-tests.mjs
```

`scripts/run-system-tests.mjs` هو المنسّق (orchestrator): يصفّر قاعدة البيانات (`reset-system-test-db.ts`) → يزرع الأدمن (`prisma/seed.ts`) → يشغّل كل زوج (seed + test) بالتسلسل، مع تمرير البيانات المزروعة بين السكربتين عبر متغيرات بيئة (`SEED_JSON`) بدل نسخ IDs يدويًا.

### السكربتات المنفذة (12 خطوة، 184 تحقّق)

| الخطوة | يغطي |
|---|---|
| `reset database` + `seed admin` | تهيئة بيئة نظيفة قبل كل تشغيلة |
| `seed-bids-test.ts` → `test-bids.mjs` | مزايدات صحيحة/خاطئة، حجز/تحرير الوديعة، صلاحيات |
| `test-antisnipe.mjs` | تمديد وقت الإغلاق التلقائي (anti-snipe) عند مزايدة قريبة من النهاية |
| `seed-favorites-test.ts` → `test-favorites.mjs` | إضافة/إزالة مفضلة، متابعة/إلغاء متابعة بائع |
| `seed-orders-test.ts` → `test-orders.mjs` | دورة حياة الطلب كاملة: فائز يدفع، فائز بلا رصيد → دفع تلقائي فاشل → مهلة تنتهي → فرصة ثانية للمزايد الثاني → فشل/نجاح |
| `seed-realtime-test.ts` → `test-realtime.mjs` | بث SSE مباشر (`bid`, `closed`, `outbid`, `won`) |
| `test-system-e2e.mjs` | **سيناريو شامل واحد** (أنشأته خصيصًا لهذا التقرير) يغطي: `/categories` العامة؛ تسجيل مستخدم + تحقق بريد بكود حقيقي من اللوق + دخول؛ تغيير/نسيان/إعادة تعيين كلمة السر؛ رفض Google auth غير الصالح؛ `PATCH /users/me` (username/dateOfBirth/phoneNumber) مع تعارض الاسم المكرر (409)؛ تحقق بائع (OTP محاكى) ومنح دور SELLER؛ وصول الأدمن لحالة واتساب؛ **دورة حياة مزاد كاملة** — إنشاء كـ draft **برفع صورة حقيقي عبر multipart إلى ImageKit**، تعديل، submit، رفض الأدمن، تعديل يعيد الإرسال تلقائيًا، موافقة الأدمن، ظهوره في التصفح العام، إلغاء الأدمن، حذف draft المالك، إلغاء البائع لمزاد pending، إنهاء الأدمن القسري؛ **محفظة** — جلب الرصيد والمعاملات، top-up حقيقي عبر Stripe Checkout (test mode)، Stripe Connect onboarding، سحب مع التحقق من القيود؛ تشغيل الجدولة الإدارية يدويًا. |

**النتيجة:** ✅ **184/184 تحقّق ناجح، 12/12 خطوة ناجحة** — تم إيقاف السيرفر التجريبي بعد التأكد من النجاح؛ لا توجد أي عمليات تشغيل متبقية على المنفذ 3100.

---

## 5. مشاكل اكتُشفت وأُصلحت أثناء الاختبار

لم تُكتشف أي أخطاء منطقية في كود الإنتاج نفسه (`src/`) — كل الإصلاحات كانت في **سكربتات الاختبار نفسها**:

1. سكربتات System Testing القديمة كانت تحتوي IDs مزروعة يدويًا بشكل ثابت (hardcoded) → عُدِّلت لتقبل `BASE_URL`/`SEED_JSON` كمتغيرات بيئة، وبُني منسّق (`run-system-tests.mjs`) يمرّرها تلقائيًا.
2. قراءة أكواد OTP من لوق السيرفر فشلت بسبب أن PowerShell يكتب الـ redirection بترميز UTF-16LE افتراضيًا على Windows بينما القراءة كانت تفترض UTF-8 → أُضيفت دالة `readLogText` تكتشف وتفك BOM الصحيح.
3. رفع الصور متعدد الأجزاء (`multipart/form-data`) عبر `fetch`+`FormData` في Node كان يفشل أحيانًا في تأطير الطلب → استُبدل ببناء الـ body يدويًا كـ `Buffer` واحد، وهذا أثبت موثوقية أكبر.
4. توقّعات حالة HTTP خاطئة في سكربت الاختبار لعمليات Stripe (توقّع 200 بدل 201 الفعلية لِـ `POST` التي تُنشئ مورد) → صُححت التوقعات لتطابق السلوك الصحيح للـ API.

---

## 6. ما لم يُغطَّ عمدًا (خارج النطاق الحالي)

- **User Acceptance Testing:** يحتاج مستخدمين حقيقيين وواجهة الموبايل الجاهزة من الفريق الآخر — قرار بتأجيله/تخطيه في هذه المرحلة.
- **Baileys/WhatsApp الحقيقي:** يُختبر عبر `SELLER_OTP_SIMULATE=true` بدل ربط جلسة واتساب فعلية (موثّق أصلًا في `docs/PROJECT-CONTEXT.md` كسلوك dev/testing مقصود).
- **إرسال بريد Brevo الفعلي:** يُختبر عبر التقاط اللوق (بدون مفتاح Brevo) بدل إرسال بريد حقيقي — يثبت أن منطق التطبيق صحيح دون الاعتماد على خدمة بريد خارجية حقيقية في كل تشغيلة.
- **حالات الفشل الشبكية لِـ Stripe/ImageKit** (مثل انقطاع الشبكة أثناء الطلب) لم تُختبر تحديدًا؛ فقط المسارات الناجحة والمرفوضة منطقيًا (validation) على مستوى API.

---

## 7. خلاصة للمشرف

المشروع يحتوي الآن على ثلاث طبقات اختبار كاملة ومؤتمتة بالكامل (قابلة لإعادة التشغيل بأمر واحد لكل طبقة)، وتغطي:
- **منطق الأعمال المعزول** (Unit — 139 اختبار)
- **التكامل بين الموديولات فوق قاعدة بيانات حقيقية** (Integration — 8 اختبارات)
- **النظام الكامل كصندوق أسود بما فيه خدمات خارجية حقيقية بوضع الاختبار** (System — 184 تحقّق)

**كل الاختبارات ناجحة حاليًا (331 تحقّق/اختبار إجمالًا عبر المستويات الثلاثة)، ولم تُكتشف أي مشكلة وظيفية في الكود الحالي.** الأمر الوحيد المتبقي بقرار صريح من صاحب المشروع هو تخطي UAT في هذه المرحلة.

### أوامر التشغيل السريعة (لإعادة الإنتاج)

```bash
# Unit
npm test

# Integration
npm run test:integration

# الاثنان معًا
npm run test:all

# System (يتطلب تشغيل السيرفر يدويًا أولًا فوق .env.system-test، انظر القسم 4)
node scripts/run-system-tests.mjs
```
