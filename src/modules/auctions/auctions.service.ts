import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuctionStatus,
  ObjectStatus,
  Prisma,
  Role,
} from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import { MailService } from '../mail/mail.service';
import type { SafeUser } from 'src/types/declartion-mergin';
import type {
  AuctionDetailDTO,
  BrowseAuctionsQueryDTO,
  CreateAuctionDTO,
  PaginatedAuctionsDTO,
  UpdateAuctionDTO,
} from './dto/auctions.dto';

// نُرجع القطعة مع صورها مرتّبة مع كل مزاد
const OBJECT_INCLUDE = {
  object: { include: { images: { orderBy: { position: 'asc' as const } } } },
} satisfies Prisma.AuctionInclude;

const DAY_MS = 24 * 60 * 60 * 1000;

// الحالات التي يجوز عرضها للعامة (لا تُسرّب المسودّات/قيد المراجعة)
const PUBLIC_STATUSES: AuctionStatus[] = [
  AuctionStatus.LIVE,
  AuctionStatus.ENDED,
  AuctionStatus.SOLD,
  AuctionStatus.UNSOLD,
];

@Injectable()
export class AuctionsService {
  constructor(
    private readonly prisma: DatabaseService,
    private readonly mail: MailService,
  ) {}

  // ======================= Seller =======================

  // إنشاء مزاد من قطعة AVAILABLE يملكها البائع → PENDING_REVIEW
  async create(sellerId: string, dto: CreateAuctionDTO) {
    const object = await this.prisma.object.findUnique({
      where: { id: dto.objectId },
    });
    if (!object) throw new NotFoundException('Object not found');
    if (object.ownerId !== sellerId) {
      throw new ForbiddenException('Not the object owner');
    }
    if (object.status !== ObjectStatus.AVAILABLE) {
      throw new BadRequestException('Object is not available for auction');
    }

    return this.prisma.$transaction(async (tx) => {
      // حجز القطعة ذرّياً (يمنع إنشاء مزادين لنفس القطعة في آنٍ واحد)
      const claimed = await tx.object.updateMany({
        where: { id: object.id, status: ObjectStatus.AVAILABLE },
        data: { status: ObjectStatus.IN_AUCTION },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Object is not available for auction');
      }

      return tx.auction.create({
        data: {
          objectId: object.id,
          startingPrice: dto.startingPrice,
          reservePrice: dto.reservePrice,
          minBidIncrement: dto.minBidIncrement, // undefined → القيمة الافتراضية 50
          durationDays: dto.durationDays,
          status: AuctionStatus.PENDING_REVIEW,
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

  // تعديل التسعير/المدّة قبل الإطلاق (PENDING_REVIEW أو REJECTED فقط)
  async update(id: string, user: SafeUser, dto: UpdateAuctionDTO) {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      include: { object: true },
    });
    if (!auction) throw new NotFoundException('Auction not found');
    this.assertOwnerOrAdmin(auction.object.ownerId, user);

    if (
      auction.status !== AuctionStatus.PENDING_REVIEW &&
      auction.status !== AuctionStatus.REJECTED
    ) {
      throw new BadRequestException(
        'Only pending or rejected auctions can be edited',
      );
    }

    // فحص reserve >= starting على القيم المدمجة (الحالية + التعديل)
    const startingPrice = dto.startingPrice ?? Number(auction.startingPrice);
    const reserve =
      dto.reservePrice === undefined
        ? auction.reservePrice === null
          ? null
          : Number(auction.reservePrice)
        : dto.reservePrice;
    if (reserve !== null && reserve < startingPrice) {
      throw new BadRequestException('reservePrice must be >= startingPrice');
    }

    return this.prisma.auction.update({
      where: { id },
      data: {
        startingPrice: dto.startingPrice,
        reservePrice: dto.reservePrice, // null = مسح، undefined = إبقاء
        minBidIncrement: dto.minBidIncrement,
        durationDays: dto.durationDays,
        // fix-and-resubmit: المرفوض يعود PENDING_REVIEW مع مسح بيانات المراجعة
        ...(auction.status === AuctionStatus.REJECTED && {
          status: AuctionStatus.PENDING_REVIEW,
          rejectionReason: null,
          reviewedById: null,
          reviewedAt: null,
        }),
      },
      include: OBJECT_INCLUDE,
    });
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

    // البائع: PENDING/REJECTED فقط. الأدمن: أي مزاد غير منتهٍ نهائياً.
    const cancellable = isAdmin
      ? auction.status !== AuctionStatus.CANCELLED &&
        auction.status !== AuctionStatus.SOLD
      : auction.status === AuctionStatus.PENDING_REVIEW ||
        auction.status === AuctionStatus.REJECTED;
    if (!cancellable) {
      throw new BadRequestException('This auction cannot be cancelled');
    }

    return this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.auction.update({
        where: { id },
        data: { status: AuctionStatus.CANCELLED },
        include: OBJECT_INCLUDE,
      });
      // تحرير القطعة إن كانت مرتبطة بهذا المزاد
      await tx.object.updateMany({
        where: { id: auction.objectId, status: ObjectStatus.IN_AUCTION },
        data: { status: ObjectStatus.AVAILABLE },
      });
      return cancelled;
    });
  }

  // ======================= Public =======================

  // تصفّح المزادات القائمة (LIVE فقط) مع فلترة/بحث/ترتيب/تقسيم
  async browse(query: BrowseAuctionsQueryDTO): Promise<PaginatedAuctionsDTO> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'endingSoon';

    const objectFilter: Prisma.ObjectWhereInput = {};
    if (query.category) objectFilter.category = query.category;
    if (query.q) {
      objectFilter.title = { contains: query.q, mode: 'insensitive' };
    }

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

    // إشعار البائع (لا يُفشل الطلب إن غاب مفتاح البريد)
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
