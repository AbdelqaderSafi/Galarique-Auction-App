# GalleryQ — تحليل النظام (Backend)

> مستند تحليل المتطلبات والنموذج المجالي (Domain Model) لتطبيق مزادات **GalleryQ / Gallerique**
> الحالة: مسوّدة متّفق عليها — يونيو 2026 · الـ Stack: **NestJS 11 + Prisma 7 + PostgreSQL**

---

## 1. نظرة عامة

GalleryQ تطبيق **مزادات** للقطع الفنية والتحف. المستخدم الواحد ممكن يكون **مشتري وبائع** بنفس الوقت (`roles[]`).
المزاد **مؤقّت بوقت محدد** مع **تمديد تلقائي** عند المزايدة بآخر لحظة (anti-sniping)، والدفع عبر **محفظة + بوابة دفع**.

مصدر التحليل: ملف Figma «app gallery Q». **النطاق المعتمد: صفحة `buyer flow AI` فقط** (تحوي شاشات المشتري والبائع معاً) — `seller flow AI` متجاهَلة. **الشحن خارج النطاق** (لا شاشات/منطق شحن).

---

## 2. القرارات المعتمدة (Product Decisions)

| القرار | التفصيل |
|--------|---------|
| نوع المزاد | مؤقّت بوقت محدّد + **تمديد تلقائي** (anti-snipe) |
| الدفع | محفظة (`balance` + `lockedBalance`) + بوابة دفع لشحن المحفظة |
| مبلغ المزايدة | **حر** بشرط ≥ السعر الحالي + `minBidIncrement` |
| العربون | **$50 ثابت** لكل مزايد، يُحجز عند **أول مزايدة** بالمزاد |
| الزائر (Guest) | **تصفّح فقط** — المزايدة/المتابعة/المفضّلة تتطلب تسجيل |
| Object vs Auction | القطعة كيان دائم، المزاد حدث مؤقّت عليها |
| التخلّف عن الدفع | عرض ثاني (second-chance) لأعلى مزايد تالٍ |

---

## 3. خريطة الشاشات (من Figma)

- **Reg:** Splash/Onboarding · إنشاء حساب · تسجيل دخول (Local + Google + Apple) · Continue as Guest
- **Explore / Search:** بحث «models, brands» + تصنيفات + chips فلترة (~10 شاشات/حالات)
- **Favorites:** ‏Fav **Auctions** · Fav **Sellers** (= Follow) · Fav **Objects**
- **Product (المشتري):** صورة + تاج `art auction` + العنوان + الوصف + **Current bid** + عدّاد تنازلي + زر **Place Bid**
- **Bid pop-up:** أزرار زيادة سريعة ($20/$30/$50/$60) أو مبلغ حر + «You'll pay only if you win» + زر Continue + **Bid history** (المزايدون + العدد + التوقيت)
- **Product (عرض البائع):** بطاقة القطعة + Details (Condition/Originality/Authenticity/Country) + `follow` + `bidders list`
- **Create (wizard 4 خطوات):** 1) Category 2) Images 3) Item Details (Era, Condition, Dimensions H/W/D) 4) Set Value (Estimated Selling Price «خاص للخبراء» + Reserve Price اختياري)
- **Dashboard (بائع):** إحصائيات + زر Create Auction
- **Sales (طلبات البائع):** تبويب Paid/Unpaid (تبويبات الشحن خارج النطاق)
- **Wallet:** الرصيد + شحن المحفظة + مكوّنات الدفع
- **Profile**

### ثغرات في التصميم (نُعالجها بالباك اند)
1. **سعر الافتتاح + مدة المزاد** — غير ظاهرين بشاشة Create. نضيفهم بالموديل/الـ DTO من الآن.

---

## 4. الكيانات (Domain Entities)

### موجودة مسبقاً
- **User** — fullName, email, password?/provider, `roles[]` (BUYER/SELLER/ADMIN)
- **SellerProfile** — توثيق البائع بالهوية (status: PENDING/APPROVED/REJECTED)
- **Wallet** — `balance` + `lockedBalance`

### جديدة
| الكيان | الوصف |
|--------|-------|
| **Category** | تصنيفات القطع (Art, Watches, Jewelry...) |
| **Object** + **ObjectImage** | القطعة الفنية (دائمة): العنوان/الوصف/الصور + Era/Condition/Originality/Authenticity/Country + الأبعاد + المالك + الحالة (AVAILABLE/IN_AUCTION/SOLD) |
| **Auction** | الحدث المؤقّت: السعر الافتتاحي/الاحتياطي/التقديري + `minBidIncrement` + `currentPrice` + التوقيت + إعدادات anti-snipe + الحالة |
| **Bid** | مزايدة: المزاد + المزايد + المبلغ + الوقت |
| **AuctionDeposit** | عربون $50 لكل مزايد بمزاد (HELD/RELEASED/FORFEITED) |
| **Order** | يُنشأ عند الفوز: الفائز/البائع/السعر + دورة Escrow مبسّطة (دفع→حجز→تأكيد استلام/تحرير تلقائي) + مهلة دفع 72h + `autoReleaseAt` |
| **Dispute** | نزاع على طلب — تحسمه الإدارة (ADMIN): تحرير للبائع أو استرداد للمشتري |
| **WalletTransaction** | سجل حركات: TOPUP/WITHDRAW/DEPOSIT_HOLD/DEPOSIT_RELEASE/DEPOSIT_FORFEIT/ESCROW_IN/ESCROW_RELEASE/REFUND |
| **FavoriteObject** | مفضّلة قطعة (userId + objectId) |
| **FavoriteAuction** | مفضّلة مزاد (userId + auctionId) |
| **Follow** | متابعة بائع (followerId + sellerId) = Fav Sellers |

> ملاحظة: تجنّبنا علاقة **polymorphic** للمفضّلة (type+targetId) وفصلناها لجداول بـ FK حقيقي → تكامل مرجعي + cascade + استعلام أسهل.

---

## 5. منطق المزايدة (Concurrency)

عند كل مزايدة — داخل **DB transaction** لمنع التضارب:
1. تحقّق: `amount ≥ currentPrice + minBidIncrement` والمزاد LIVE.
2. لو أول مزايدة للمستخدم بهالمزاد → احجز عربون $50 (`balance −50 → lockedBalance`, سجل `DEPOSIT_HOLD`, أنشئ `AuctionDeposit`).
3. حدّث `currentPrice` و `currentWinnerId`، أنشئ `Bid`.
4. لو المزايدة بآخر `antiSnipeSeconds` → `endTime += extendBySeconds`.

---

## 6. دورة حياة المزاد + الدفع

```
SCHEDULED ──(startTime)──► LIVE ──(endTime)──► ENDED ──► [حسم النتيجة]

[حسم النتيجة]: فيه مزايدات ≥ reservePrice؟
 ├─ لا  → UNSOLD، Object → AVAILABLE
 └─ نعم → الفائز = أعلى مزايد → Order (UNPAID, deadline = الآن + 72h)
          amountDue = finalPrice − 50  (العربون يُطبّق ضمن السعر)
          ├─ رصيد المحفظة يكفي / دُفع خلال 72h → PAID_IN_ESCROW → Object SOLD (راجع 6.1)
          └─ تخلّف 72h → DEPOSIT_FORFEIT ($50 يُخصم نهائياً)
                         └─► عرض لثاني أعلى مزايد → Order جديد (72h) → ... تسلسل
                             └─ خلصت المزايدات → UNSOLD، Object → AVAILABLE
```
عند الحسم النهائي: عرابين المزايدين غير المتخلّفين → **RELEASED**.

---

## 6.1 نظام التحصيل المالي (Escrow) — مبسّط بدون شحن

> نموذج Catawiki مبسّط. **التطبيق هو الضامن المالي.** (الشحن خارج النطاق — لا تتبّع/ناقل/حالات شحن.)

### حالات رصيد المحفظة (3)
- **المتاح (Available)** = `balance` (قابل للسحب)
- **المعلّق (Pending)** = `lockedBalance` (عرابين $50 لمزادات قائمة)
- **المحجوز (In-Escrow)** = مبالغ طلبات مدفوعة بانتظار التحرير (تُحسب من الطلبات)

### دورة المال بعد الدفع (Escrow)
```
الدفع → المال يدخل الحجز (ESCROW_IN)  [Order: PAID_IN_ESCROW]
  ├─ المشتري يؤكّد الاستلام → تحرير للبائع (ESCROW_RELEASE)        [COMPLETED]
  ├─ مرّ N يوم من الدفع بلا نزاع → تحرير تلقائي (Cron)            [COMPLETED]
  └─ المشتري يرفع نزاعاً → تجميد + مراجعة ADMIN                   [DISPUTED]
         └─ الإدارة: تحرير للبائع (RESOLVED_SELLER) أو استرداد (RESOLVED_BUYER → REFUNDED)
```
- **التواصل:** بريد إلكتروني (`mailto:`) فقط — **لا حاجة لـ module دردشة**.

---

## 7. الوحدات (Modules)

موجودة: `auth` · `user` · `database`
جديدة: `categories` · `objects` · `auctions` · `bids` · `orders` (+ escrow) · `disputes` · `wallet` (+ payment gateway) · `favorites` · `follows` · `uploads` · `scheduler`

### مهام الـ Scheduler (Cron)
1. إغلاق المزادات المنتهية + حسم النتيجة.
2. فحص مهلة الدفع 72h → مصادرة العربون + second-chance.
3. فحص التحرير التلقائي (بعد مدة من الدفع، بلا نزاع) → تحرير المال للبائع.

---

## 8. أبرز نقاط الـ API (مبدئي)

- **Auctions:** قائمة/تفاصيل (عام للزوّار) · إنشاء (بائع موثّق) · مزايدة (مشتري مسجّل)
- **Bids:** مزايدة + سجل المزايدين لكل مزاد
- **Wallet:** الرصيد · شحن (gateway) · سحب · سجل الحركات
- **Orders:** طلبات المشتري · طلبات البائع (Paid/Unpaid) · دفع طلب · تأكيد الاستلام (تحرير) · رفع نزاع
- **Favorites/Follows:** إضافة/حذف · قوائم
- **Scheduler:** إغلاق المزادات المنتهية · فحص مهلة 72h + second-chance · التحرير التلقائي للحجز

---

## 9. ملاحظات تقنية
- استخدام **Decimal** بدل Float للمبالغ يُفضّل (دقة مالية) — يُحسم عند كتابة الـ schema.
- العربون والمهل تعتمد على **scheduler** موثوق (إغلاق المزاد + 72h).
- حماية كل مسارات المزايدة/المفضّلة بـ Guard (تتطلب تسجيل).
