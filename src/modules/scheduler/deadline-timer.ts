import type { Logger } from '@nestjs/common';

// setTimeout ينهار فوق 2^31-1 ms (~24.8 يوم) ويتحوّل لتنفيذ فوري متكرّر.
// فوق هذا الحدّ ننام للحدّ الأقصى ثم نعيد الحساب بلا تنفيذ عمل.
const MAX_TIMEOUT_MS = 2_147_483_647;

// المؤقّت قد يستيقظ قبل الموعد بأجزاء من الميلي ثانية، فيجد الصف "غير مستحقّ"
// ويعيد جدولة نفسه في حلقة ضيّقة. الهامش يضمن أن الاستيقاظ دائماً بعد الموعد.
const SKEW_MS = 150;

// فشل قراءة الموعد التالي (القاعدة نائمة/انقطاع شبكة) — أعد المحاولة
// بدل ترك المؤقّت ميّتاً إلى الأبد.
const RETRY_MS = 60_000;

// صفٌّ مستحقّ فشل إغلاقه يبقى مستحقّاً، فيعيد المؤقّت جدولة نفسه فوراً بلا نهاية.
// التراجع التصاعدي يحوّل الحلقة الضيّقة إلى محاولة كل 5ث ثم 10ث... بسقف نصف ساعة.
const STALE_BACKOFF_MS = 5_000;
const STALE_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * مؤقّت يستيقظ عند أقرب موعد مستحقّ فعلياً في قاعدة البيانات، بدل استطلاع دوري.
 *
 * لا موعد قادم = لا مؤقّت = صفر استعلامات، فتنام قاعدة Neon (scale-to-zero بعد
 * 5 دقائق خمول) وتتوقّف فوترة الـ CU-hours. أي نبض أسرع من 5 دقائق يبقيها صاحية
 * على مدار الساعة — وهذا بالضبط ما كان يستهلك الحصّة الشهرية.
 *
 * `rearm()` يستدعيها كل ما يغيّر موعداً (موافقة أدمن، تمديد anti-snipe، إلغاء)،
 * وتُستدعى تلقائياً بعد كل تنفيذ. الاستدعاءات المتزامنة تُسلسَل فلا يتراكم
 * أكثر من مؤقّت واحد حيّ.
 */
export class DeadlineTimer {
  private handle: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private queued = false;
  private stopped = false;
  private armedFor: Date | null = null;
  // آخر موعد نُفِّذ عليه العمل فعلاً، وعدّاد المرّات التي عاد فيها نفس الموعد بعده
  private lastFiredDeadline = 0;
  private staleRuns = 0;

  constructor(
    private readonly name: string,
    /** أقرب موعد مستحقّ، أو null إذا لا يوجد عمل قادم إطلاقاً */
    private readonly nextDueAt: () => Promise<Date | null>,
    /** العمل الذي يُنفَّذ عند حلول الموعد — لازم يكون idempotent */
    private readonly onDue: () => Promise<void>,
    private readonly logger: Logger,
  ) {}

  /** أقرب موعد مضبوط حالياً (للتشخيص والاختبارات) */
  get nextFireAt(): Date | null {
    return this.armedFor;
  }

  /** أعد ضبط المؤقّت على أقرب موعد في القاعدة. آمنة للاستدعاء المتكرّر. */
  rearm(): void {
    if (this.stopped) return;

    // ضبط جارٍ بالفعل — علّم أننا نحتاج جولة أخرى بعده بدل تشغيل استعلامين متوازيين
    if (this.running) {
      this.queued = true;
      return;
    }

    this.running = this.computeAndArm().finally(() => {
      this.running = null;
      if (this.queued) {
        this.queued = false;
        this.rearm();
      }
    });
  }

  /** إيقاف نهائي عند إغلاق التطبيق */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private async computeAndArm(): Promise<void> {
    this.clear();

    let due: Date | null;
    try {
      due = await this.nextDueAt();
    } catch (e) {
      this.logger.error(
        `${this.name}: failed to read next deadline, retrying in ${RETRY_MS}ms: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      this.arm(RETRY_MS, false);
      return;
    }

    // لا عمل قادم → لا مؤقّت. القاعدة تخمل وتنام.
    if (!due) {
      this.lastFiredDeadline = 0;
      this.staleRuns = 0;
      return;
    }

    this.armedFor = due;

    // نفس الموعد الذي نفّذنا عليه للتوّ ما زال مستحقّاً → الصف عالق (فشل إغلاق
    // متكرّر مثلاً). بلا تراجع تصاعدي تتحوّل هذه الحالة إلى حلقة ضيّقة تهاجم
    // القاعدة إلى الأبد — أسوأ بكثير من الـ cron الذي نستبدله.
    if (due.getTime() <= this.lastFiredDeadline) {
      this.staleRuns++;
      const backoff = Math.min(
        STALE_BACKOFF_MS * 2 ** (this.staleRuns - 1),
        STALE_BACKOFF_MAX_MS,
      );
      this.logger.warn(
        `${this.name}: deadline ${due.toISOString()} still due after ${this.staleRuns} run(s), retrying in ${backoff}ms`,
      );
      this.arm(backoff, true);
      return;
    }
    this.staleRuns = 0;

    const delay = due.getTime() - Date.now() + SKEW_MS;

    // موعد أبعد من سقف setTimeout → نم للسقف ثم أعد الحساب بلا تنفيذ
    if (delay > MAX_TIMEOUT_MS) {
      this.arm(MAX_TIMEOUT_MS, false);
      return;
    }
    this.arm(delay, true);
  }

  private arm(delayMs: number, fireWork: boolean): void {
    if (this.stopped) return;
    const ms = Math.min(Math.max(delayMs, 0), MAX_TIMEOUT_MS);
    this.handle = setTimeout(() => {
      this.handle = null;
      if (fireWork) void this.fire();
      else this.rearm();
    }, ms);
    // لا يمنع الخروج من العملية — مهم حتى لا تتعلّق اختبارات jest
    this.handle.unref();
  }

  private async fire(): Promise<void> {
    if (this.armedFor) this.lastFiredDeadline = this.armedFor.getTime();
    this.armedFor = null;
    try {
      await this.onDue();
    } catch (e) {
      this.logger.error(
        `${this.name}: run failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // سواء نجح أو فشل — أعد الضبط على الموعد التالي (الفاشل يُلتقط بالجولة الجاية)
    this.rearm();
  }

  private clear(): void {
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
    this.armedFor = null;
  }
}
