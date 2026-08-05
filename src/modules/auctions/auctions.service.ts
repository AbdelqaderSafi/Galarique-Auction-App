import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuctionStatus,
  DepositStatus,
  ObjectStatus,
  OrderStatus,
  Prisma,
  Role,
} from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import { WalletService } from '../wallet/wallet.service';
import type { SafeUser } from 'src/types/declartion-mergin';
import type {
  AuctionDetailDTO,
  BrowseAuctionsQueryDTO,
  CreateAuctionData,
  PaginatedAuctionsDTO,
  PaginatedSellerAuctionsDTO,
  SellerAuctionsQueryDTO,
  UpdateAuctionDTO,
} from './dto/auctions.dto';

// نُرجع القطعة مع صورها مرتّبة مع كل مزاد
const OBJECT_INCLUDE = {
  object: { include: { images: { orderBy: { position: 'asc' as const } } } },
} satisfies Prisma.AuctionInclude;

const SELLER_AUCTIONS_INCLUDE = {
  object: {
    include: {
      images: { orderBy: { position: 'asc' as const } },
      owner: { select: { fullName: true } },
    },
  },
} satisfies Prisma.AuctionInclude;

const DAY_MS = 24 * 60 * 60 * 1000;

// الحالات التي يجوز عرضها للعامة (لا تُسرّب المسودّات/قيد المراجعة)
export const PUBLIC_STATUSES: AuctionStatus[] = [
  AuctionStatus.LIVE,
  AuctionStatus.ENDED,
  AuctionStatus.SOLD,
  AuctionStatus.UNSOLD,
];

// الحالات التي يجوز فيها التعديل (قبل الإطلاق)
const EDITABLE_STATUSES: AuctionStatus[] = [
  AuctionStatus.DRAFT,
  AuctionStatus.PENDING_REVIEW,
  AuctionStatus.REJECTED,
];

@Injectable()
export class AuctionsService {
  constructor(
    private readonly prisma: DatabaseService,
    private readonly mail: MailService,
    private readonly wallet: WalletService,
  ) {}

  // ======================= Seller =======================

  // إنشاء المزاد بالكامل: القطعة (Object) + المزاد (Auction) في transaction واحد
  // (الصور تكون مرفوعة مسبقاً كروابط في dto.mainImage / dto.images)
  async create(sellerId: string, dto: CreateAuctionData) {
    const { images, startingPrice, durationDays, saveAsDraft, ...objectScalars } =
      dto;

    const auctionStatus = saveAsDraft
      ? AuctionStatus.DRAFT
      : AuctionStatus.PENDING_REVIEW;
    const objectStatus = saveAsDraft
      ? ObjectStatus.DRAFT
      : ObjectStatus.IN_AUCTION;

    return this.prisma.$transaction(async (tx) => {
      const object = await tx.object.create({
        data: {
          ...objectScalars,
          ownerId: sellerId,
          status: objectStatus,
          images: images?.length
            ? { create: images.map((url, position) => ({ url, position })) }
            : undefined,
        },
      });

      // minBidIncrement غير مذكور عمداً — ثابت $10 من @default في schema.prisma
      return tx.auction.create({
        data: {
          objectId: object.id,
          startingPrice,
          durationDays,
          status: auctionStatus,
        },
        include: OBJECT_INCLUDE,
      });
    });
  }

  // مزادات البائع الحالي (كل الحالات)
  findMine(sellerId: string) {
    return this.prisma.auction.findMany({
      where: { object: { ownerId: sellerId } },
      include: OBJECT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  // تعديل بيانات القطعة + المزاد قبل الإطلاق (DRAFT/PENDING_REVIEW/REJECTED)
  async update(id: string, user: SafeUser, dto: UpdateAuctionDTO) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { object: true },
    });
    if (!auction) throw new NotFoundException('Auction not found');
    this.assertOwnerOrAdmin(auction.object.ownerId, user);
    if (!EDITABLE_STATUSES.includes(auction.status)) {
      throw new BadRequestException('This auction can no longer be edited');
    }

    const { images, startingPrice, durationDays, ...objectScalars } = dto;

    return this.prisma.$transaction(async (tx) => {
      // حقول القطعة (تفاصيل/تصنيف/صور)
      if (Object.keys(objectScalars).length > 0 || images !== undefined) {
        await tx.object.update({
          where: { id: auction.objectId },
          data: {
            ...objectScalars,
            ...(images !== undefined && {
              images: {
                deleteMany: {},
                create: images.map((url, position) => ({ url, position })),
              },
            }),
          },
        });
      }

      // حقول المزاد + إعادة المرفوض للمراجعة (fix-and-resubmit)
      return tx.auction.update({
        where: { id },
        data: {
          startingPrice,
          durationDays,
          ...(auction.status === AuctionStatus.REJECTED && {
            status: AuctionStatus.PENDING_REVIEW,
            rejectionReason: null,
            reviewedById: null,
            reviewedAt: null,
          }),
        },
        include: OBJECT_INCLUDE,
      });
    });
  }

  // إرسال المسودّة للمراجعة: DRAFT → PENDING_REVIEW (Object → IN_AUCTION)
  async submit(id: string, user: SafeUser) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { object: true },
    });
    if (!auction) throw new NotFoundException('Auction not found');
    this.assertOwnerOrAdmin(auction.object.ownerId, user);
    if (auction.status !== AuctionStatus.DRAFT) {
      throw new BadRequestException('Only draft auctions can be submitted');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.object.update({
        where: { id: auction.objectId },
        data: { status: ObjectStatus.IN_AUCTION },
      });
      return tx.auction.update({
        where: { id },
        data: { status: AuctionStatus.PENDING_REVIEW },
        include: OBJECT_INCLUDE,
      });
    });
  }

  // حذف مسودّة (يمسح القطعة وصورها معها) — DRAFT فقط
  async remove(id: string, user: SafeUser) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { object: true },
    });
    if (!auction) throw new NotFoundException('Auction not found');
    this.assertOwnerOrAdmin(auction.object.ownerId, user);
    if (auction.status !== AuctionStatus.DRAFT) {
      throw new BadRequestException('Only draft auctions can be deleted');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.auction.delete({ where: { id } });
      await tx.object.delete({ where: { id: auction.objectId } });
    });
    return { message: 'Draft auction deleted successfully.' };
  }

  // إلغاء المزاد → CANCELLED وإرجاع القطعة AVAILABLE
  async cancel(id: string, user: SafeUser) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { object: true },
    });
    if (!auction) throw new NotFoundException('Auction not found');

    const isAdmin = user.roles.includes(Role.ADMIN);
    const isOwner = auction.object.ownerId === user.id;
    if (!isAdmin && !isOwner) throw new ForbiddenException();

    // فحص مبكّر لرسالة خطأ سريعة؛ الفحص المُلزِم يتكرّر داخل الـ transaction بعد القفل
    if (!this.isCancellable(auction.status, isAdmin)) {
      throw new BadRequestException('This auction cannot be cancelled');
    }

    return this.prisma.$transaction(async (tx) => {
      // قفل صف المزاد — يمنع سباق الإلغاء مع مزايدة جارية أو مع إغلاق السكدولر
      await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${id} FOR UPDATE`;

      // إعادة فحص الحالة بعد القفل (قد تكون تغيّرت بين القراءة والقفل)
      const fresh = await tx.auction.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!fresh) throw new NotFoundException('Auction not found');
      if (!this.isCancellable(fresh.status, isAdmin)) {
        throw new BadRequestException('This auction cannot be cancelled');
      }

      // أي طلب دفع مفتوح يُلغى مع المزاد — وإلا يلتقطه السكدولر لاحقاً
      // (retryWinnerPayments) فيخصم من المشتري ويرجّع المزاد SOLD بعد إلغائه
      await tx.order.updateMany({
        where: { auctionId: id, status: OrderStatus.AWAITING_PAYMENT },
        data: { status: OrderStatus.CANCELLED },
      });

      // أي عربون ما زال محجوزاً على هذا المزاد يعود لصاحبه فوراً،
      // وإلا بقي $50 عالقاً في lockedBalance للأبد (لا جوب يعالج CANCELLED)
      const heldDeposits = await tx.auctionDeposit.findMany({
        where: { auctionId: id, status: DepositStatus.HELD },
        select: { userId: true },
      });
      for (const { userId } of heldDeposits) {
        await this.wallet.releaseBidDeposit(
          tx,
          userId,
          id,
          'Bid deposit released (auction cancelled)',
        );
      }

      const cancelled = await tx.auction.update({
        where: { id },
        data: { status: AuctionStatus.CANCELLED },
        include: OBJECT_INCLUDE,
      });
      await tx.object.updateMany({
        where: {
          id: auction.objectId,
          status: { in: [ObjectStatus.IN_AUCTION, ObjectStatus.DRAFT] },
        },
        data: { status: ObjectStatus.AVAILABLE },
      });
      return cancelled;
    });
  }

  // البائع: PENDING/REJECTED فقط. الأدمن: أي مزاد غير منتهٍ نهائياً.
  private isCancellable(status: AuctionStatus, isAdmin: boolean): boolean {
    return isAdmin
      ? status !== AuctionStatus.CANCELLED && status !== AuctionStatus.SOLD
      : status === AuctionStatus.PENDING_REVIEW ||
          status === AuctionStatus.REJECTED;
  }

  // ======================= Public =======================

  // تصفّح المزادات القائمة (LIVE فقط) مع فلترة/بحث/ترتيب/تقسيم
  async browse(query: BrowseAuctionsQueryDTO): Promise<PaginatedAuctionsDTO> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'endingSoon';

    const objectFilter: Prisma.ObjectWhereInput = {};
    if (query.category) objectFilter.category = query.category;
    if (query.q) objectFilter.title = { contains: query.q, mode: 'insensitive' };

    const where: Prisma.AuctionWhereInput = {
      status: AuctionStatus.LIVE,
      ...(Object.keys(objectFilter).length > 0 && { object: objectFilter }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auction.findMany({
        where,
        include: OBJECT_INCLUDE,
        orderBy: this.sortToOrderBy(sort),
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auction.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  // تفاصيل مزاد للعامة — فقط الحالات العامة، مع زيادة العدّاد وعدد المزايدات
  async findPublic(id: string): Promise<AuctionDetailDTO> {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { ...OBJECT_INCLUDE, _count: { select: { bids: true } } },
    });
    if (!auction || !PUBLIC_STATUSES.includes(auction.status)) {
      throw new NotFoundException('Auction not found');
    }

    await this.prisma.auction.update({
      where: { id },
      data: { viewsCount: { increment: 1 } },
    });

    const { _count, ...rest } = auction;
    return { ...rest, viewsCount: rest.viewsCount + 1, bidCount: _count.bids };
  }

  // كل مزادات بائع معيّن (عام) — LIVE + ما انتهى (ENDED/SOLD/UNSOLD)، الأحدث أولاً
  async findBySeller(
    sellerId: string,
    query: SellerAuctionsQueryDTO,
  ): Promise<PaginatedSellerAuctionsDTO> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.AuctionWhereInput = {
      status: { in: PUBLIC_STATUSES },
      object: { ownerId: sellerId },
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auction.findMany({
        where,
        include: SELLER_AUCTIONS_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auction.count({ where }),
    ]);

    const mappedItems = items.map(
      ({ object: { owner, ...object }, ...auction }) => ({
        ...auction,
        object,
        sellerName: owner.fullName,
      }),
    );

    return { items: mappedItems, total, page, limit };
  }

  // ======================= Admin =======================

  // طابور المراجعة (PENDING_REVIEW) — الأقدم أولاً
  pendingQueue() {
    return this.prisma.auction.findMany({
      where: { status: AuctionStatus.PENDING_REVIEW },
      include: OBJECT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  // موافقة الأدمن → LIVE + ضبط التوقيت
  async approve(id: string, adminId: string) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { object: { include: { owner: true } } },
    });
    if (!auction) throw new NotFoundException('Auction not found');
    if (auction.status !== AuctionStatus.PENDING_REVIEW) {
      throw new BadRequestException('Only pending auctions can be approved');
    }

    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + auction.durationDays * DAY_MS);

    const updated = await this.prisma.auction.update({
      where: { id },
      data: {
        status: AuctionStatus.LIVE,
        startTime,
        endTime,
        reviewedById: adminId,
        reviewedAt: startTime,
        rejectionReason: null,
      },
      include: OBJECT_INCLUDE,
    });

    await this.mail.sendAuctionApproved(
      auction.object.owner.email,
      auction.object.owner.fullName,
      auction.object.title,
    );

    return updated;
  }

  // رفض الأدمن → REJECTED + سبب
  async reject(id: string, adminId: string, reason: string) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { object: { include: { owner: true } } },
    });
    if (!auction) throw new NotFoundException('Auction not found');
    if (auction.status !== AuctionStatus.PENDING_REVIEW) {
      throw new BadRequestException('Only pending auctions can be rejected');
    }

    const updated = await this.prisma.auction.update({
      where: { id },
      data: {
        status: AuctionStatus.REJECTED,
        rejectionReason: reason,
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
      include: OBJECT_INCLUDE,
    });

    await this.mail.sendAuctionRejected(
      auction.object.owner.email,
      auction.object.owner.fullName,
      auction.object.title,
      reason,
    );

    return updated;
  }

  // ======================= Helpers =======================

  private sortToOrderBy(
    sort: NonNullable<BrowseAuctionsQueryDTO['sort']>,
  ): Prisma.AuctionOrderByWithRelationInput[] {
    switch (sort) {
      case 'newest':
        return [{ createdAt: 'desc' }];
      // currentPrice = 0 حتى أول مزايدة؛ نكسر التعادل بـ startingPrice
      case 'priceLow':
        return [{ currentPrice: 'asc' }, { startingPrice: 'asc' }];
      case 'priceHigh':
        return [{ currentPrice: 'desc' }, { startingPrice: 'desc' }];
      case 'endingSoon':
      default:
        return [{ endTime: 'asc' }];
    }
  }

  private assertOwnerOrAdmin(ownerId: string, user: SafeUser): void {
    if (ownerId !== user.id && !user.roles.includes(Role.ADMIN)) {
      throw new ForbiddenException();
    }
  }
}
