import { Logger } from '@nestjs/common';
import { AuctionStatus, OrderStatus } from 'generated/prisma/client';
import { SchedulerService } from './scheduler.service';
import { SettlementService } from '../orders/settlement.service';
import {
  createMockDatabaseService,
  resetMockDatabaseService,
  type MockDatabaseService,
} from '../../test-utils/prisma-mock';

const SEC = 1000;
const HOUR = 60 * 60 * SEC;

describe('SchedulerService', () => {
  let prisma: MockDatabaseService;
  let settlement: jest.Mocked<SettlementService>;
  let service: SchedulerService;

  // الاستعلامان يختاران عموداً واحداً فقط، فنموّه بما يقرأه الكود لا بالصف كاملاً
  const auctionEndingAt = (endTime: Date) => ({ endTime }) as any;
  const orderDueAt = (paymentDeadline: Date) => ({ paymentDeadline }) as any;

  // لا مواعيد قادمة — الحالة الافتراضية لكل اختبار
  const noDeadlines = () => {
    prisma.auction.findFirst.mockResolvedValue(null as any);
    prisma.order.findFirst.mockResolvedValue(null as any);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    prisma = createMockDatabaseService();
    settlement = {
      closeDueAuctions: jest.fn().mockResolvedValue(0),
      expirePaymentDeadlines: jest.fn().mockResolvedValue(0),
      retryWinnerPayments: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<SettlementService>;

    service = new SchedulerService(prisma, settlement);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    resetMockDatabaseService(prisma);
    jest.restoreAllMocks();
  });

  describe('لا استطلاع دوري', () => {
    it('لا يضبط أي مؤقّت حين لا يوجد موعد قادم — صفر استعلامات فتنام القاعدة', async () => {
      noDeadlines();

      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(1);

      expect(service.armedAt).toEqual({ close: null, expiry: null });
      expect(prisma.auction.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.order.findFirst).toHaveBeenCalledTimes(1);

      // 24 ساعة لاحقاً: ولا استيقاظ إضافي (دورة الأمان cron وليست مؤقّتاً)
      await jest.advanceTimersByTimeAsync(24 * HOUR);
      expect(prisma.auction.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.order.findFirst).toHaveBeenCalledTimes(1);
      expect(settlement.closeDueAuctions).not.toHaveBeenCalled();
    });

    it('يقرأ أقرب موعد باستعلام واحد مفهرس لكل مؤقّت', async () => {
      noDeadlines();

      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);

      expect(prisma.auction.findFirst).toHaveBeenCalledWith({
        where: { status: AuctionStatus.LIVE, endTime: { not: null } },
        orderBy: { endTime: 'asc' },
        select: { endTime: true },
      });
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { status: OrderStatus.AWAITING_PAYMENT },
        orderBy: { paymentDeadline: 'asc' },
        select: { paymentDeadline: true },
      });
    });
  });

  describe('مؤقّت الإغلاق', () => {
    it('ينام حتى endTime بالضبط ثم يغلق — ولا يغلق قبله', async () => {
      const endTime = new Date(Date.now() + 30 * SEC);
      prisma.auction.findFirst
        .mockResolvedValueOnce(auctionEndingAt(endTime))
        .mockResolvedValue(null as any);
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);
      expect(service.armedAt.close).toEqual(endTime);

      await jest.advanceTimersByTimeAsync(29 * SEC);
      expect(settlement.closeDueAuctions).not.toHaveBeenCalled();

      // 30s + هامش الانحراف
      await jest.advanceTimersByTimeAsync(2 * SEC);
      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);
    });

    it('يغلق فور الإقلاع ما فات أثناء توقّف الخدمة', async () => {
      prisma.auction.findFirst
        .mockResolvedValueOnce(auctionEndingAt(new Date(Date.now() - 60 * SEC)))
        .mockResolvedValue(null as any);
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(1);

      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);
    });

    it('reschedule بعد تمديد anti-snipe يزيح الاستيقاظ للموعد الجديد', async () => {
      const original = new Date(Date.now() + 30 * SEC);
      const extended = new Date(original.getTime() + 60 * SEC);

      prisma.auction.findFirst
        .mockResolvedValueOnce(auctionEndingAt(original))
        .mockResolvedValueOnce(auctionEndingAt(extended))
        .mockResolvedValue(null as any);
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);
      expect(service.armedAt.close).toEqual(original);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);
      expect(service.armedAt.close).toEqual(extended);

      // الموعد الأصلي مرّ ولم يغلق شيئاً
      await jest.advanceTimersByTimeAsync(31 * SEC);
      expect(settlement.closeDueAuctions).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(61 * SEC);
      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);
    });

    it('الإغلاق بفائز يعيد ضبط مؤقّت مهلة الدفع على الطلب الجديد', async () => {
      const deadline = new Date(Date.now() + 72 * HOUR);
      settlement.closeDueAuctions.mockResolvedValue(1);

      prisma.auction.findFirst
        .mockResolvedValueOnce(auctionEndingAt(new Date(Date.now() + SEC)))
        .mockResolvedValue(null as any);
      prisma.order.findFirst
        .mockResolvedValueOnce(null as any)
        .mockResolvedValue(orderDueAt(deadline));

      service.reschedule();
      await jest.advanceTimersByTimeAsync(2 * SEC);

      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);
      expect(service.armedAt.expiry).toEqual(deadline);
    });
  });

  describe('مؤقّت مهلة الدفع', () => {
    it('ينام حتى paymentDeadline ثم ينفّذ انتهاء المهلة', async () => {
      const deadline = new Date(Date.now() + 72 * HOUR);
      prisma.auction.findFirst.mockResolvedValue(null as any);
      prisma.order.findFirst
        .mockResolvedValueOnce(orderDueAt(deadline))
        .mockResolvedValue(null as any);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);
      expect(service.armedAt.expiry).toEqual(deadline);

      await jest.advanceTimersByTimeAsync(72 * HOUR + SEC);
      expect(settlement.expirePaymentDeadlines).toHaveBeenCalledTimes(1);
      // مؤقّت الإغلاق لم يُستدعَ عبثاً
      expect(settlement.closeDueAuctions).not.toHaveBeenCalled();
    });
  });

  describe('المتانة', () => {
    it('فشل قراءة الموعد يعيد المحاولة بدل ترك المؤقّت ميّتاً', async () => {
      prisma.auction.findFirst
        .mockRejectedValueOnce(new Error('db asleep'))
        .mockResolvedValue(null as any);
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);
      expect(prisma.auction.findFirst).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60 * SEC);
      expect(prisma.auction.findFirst).toHaveBeenCalledTimes(2);
    });

    it('فشل الإغلاق لا يمنع إعادة الضبط للموعد التالي', async () => {
      const next = new Date(Date.now() + 10 * SEC);
      settlement.closeDueAuctions.mockRejectedValueOnce(new Error('boom'));

      prisma.auction.findFirst
        .mockResolvedValueOnce(auctionEndingAt(new Date(Date.now() + SEC)))
        .mockResolvedValueOnce(auctionEndingAt(next))
        .mockResolvedValue(null as any);
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(2 * SEC);

      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);
      expect(service.armedAt.close).toEqual(next);
    });

    it('reschedule المتلاحق يُدمج — استعلامان لا ثلاثة، ومؤقّت واحد', async () => {
      const endTime = new Date(Date.now() + 5 * SEC);
      settlement.closeDueAuctions.mockResolvedValue(1);
      prisma.auction.findFirst
        .mockResolvedValueOnce(auctionEndingAt(endTime))
        .mockResolvedValueOnce(auctionEndingAt(endTime))
        .mockResolvedValue(null as any);
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.reschedule();
      service.reschedule();
      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);

      // الثالث يُدمج مع الثاني بدل استعلام مستقلّ
      expect(prisma.auction.findFirst).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(6 * SEC);
      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);
    });

    it('صفّ عالق لا يُغلق يتراجع تصاعدياً بدل حلقة ضيّقة على القاعدة', async () => {
      // الموعد يبقى مستحقّاً مهما نفّذنا — يحاكي فشل إغلاق متكرّر
      prisma.auction.findFirst.mockResolvedValue(
        auctionEndingAt(new Date(Date.now() + SEC)),
      );
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(2 * SEC);
      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);

      // 5ث للمحاولة الثانية، ثم 10ث للثالثة — لا إعادة تنفيذ فورية
      await jest.advanceTimersByTimeAsync(5 * SEC + 100);
      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5 * SEC);
      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(5 * SEC + 100);
      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(3);

      // بعد ساعة عالقة: عشرات المحاولات لا آلافها
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(settlement.closeDueAuctions.mock.calls.length).toBeLessThan(15);
    });

    it('onModuleDestroy يوقف المؤقّتات', async () => {
      prisma.auction.findFirst.mockResolvedValue(
        auctionEndingAt(new Date(Date.now() + 5 * SEC)),
      );
      prisma.order.findFirst.mockResolvedValue(null as any);

      service.reschedule();
      await jest.advanceTimersByTimeAsync(1);
      service.onModuleDestroy();

      await jest.advanceTimersByTimeAsync(60 * SEC);
      expect(settlement.closeDueAuctions).not.toHaveBeenCalled();
    });
  });

  describe('runAll / دورة الأمان', () => {
    it('يشغّل المهام الثلاث ويرجّع العدادات', async () => {
      noDeadlines();
      settlement.closeDueAuctions.mockResolvedValue(2);
      settlement.expirePaymentDeadlines.mockResolvedValue(1);
      settlement.retryWinnerPayments.mockResolvedValue(3);

      await expect(service.runAll()).resolves.toEqual({
        closed: 2,
        expired: 1,
        retriedPaid: 3,
      });
    });

    it('يعيد ضبط المؤقّتين بعد التنفيذ', async () => {
      const endTime = new Date(Date.now() + 20 * SEC);
      const deadline = new Date(Date.now() + 48 * HOUR);
      prisma.auction.findFirst.mockResolvedValue(auctionEndingAt(endTime));
      prisma.order.findFirst.mockResolvedValue(orderDueAt(deadline));

      await service.runAll();
      await jest.advanceTimersByTimeAsync(1);

      expect(service.armedAt).toEqual({ close: endTime, expiry: deadline });
    });

    it('sweep يمرّ عبر runAll', async () => {
      noDeadlines();

      await service.sweep();

      expect(settlement.closeDueAuctions).toHaveBeenCalledTimes(1);
      expect(settlement.expirePaymentDeadlines).toHaveBeenCalledTimes(1);
      expect(settlement.retryWinnerPayments).toHaveBeenCalledTimes(1);
    });
  });
});
