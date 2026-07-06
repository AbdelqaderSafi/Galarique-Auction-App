import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ObjectStatus, Role } from 'generated/prisma/client';
import { DatabaseService } from '../database/database.service';
import type { SafeUser } from 'src/types/declartion-mergin';
import type { CreateObjectDTO, UpdateObjectDTO } from './dto/objects.dto';

const IMAGES_ORDER = { images: { orderBy: { position: 'asc' as const } } };

@Injectable()
export class ObjectsService {
  constructor(private readonly prisma: DatabaseService) {}

  async create(ownerId: string, dto: CreateObjectDTO) {
    const { images, ...scalars } = dto;
    return this.prisma.object.create({
      data: {
        ...scalars,
        ownerId,
        status: ObjectStatus.AVAILABLE,
        images: images?.length
          ? { create: images.map((url, position) => ({ url, position })) }
          : undefined,
      },
      include: IMAGES_ORDER,
    });
  }

  findMine(ownerId: string) {
    return this.prisma.object.findMany({
      where: { ownerId },
      include: IMAGES_ORDER,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: SafeUser) {
    const object = await this.prisma.object.findUnique({
      where: { id },
      include: IMAGES_ORDER,
    });
    if (!object) throw new NotFoundException('Object not found');
    this.assertOwnerOrAdmin(object.ownerId, user);
    return object;
  }

  async update(id: string, user: SafeUser, dto: UpdateObjectDTO) {
    const object = await this.prisma.object.findUnique({ where: { id } });
    if (!object) throw new NotFoundException('Object not found');
    this.assertOwnerOrAdmin(object.ownerId, user);
    this.assertEditable(object.status);

    const { images, ...scalars } = dto;
    return this.prisma.object.update({
      where: { id },
      data: {
        ...scalars,
        // إن أُرسلت صور، نستبدل القائمة بالكامل
        ...(images !== undefined && {
          images: {
            deleteMany: {},
            create: images.map((url, position) => ({ url, position })),
          },
        }),
      },
      include: IMAGES_ORDER,
    });
  }

  async remove(id: string, user: SafeUser) {
    const object = await this.prisma.object.findUnique({ where: { id } });
    if (!object) throw new NotFoundException('Object not found');
    this.assertOwnerOrAdmin(object.ownerId, user);
    this.assertEditable(object.status);

    await this.prisma.object.delete({ where: { id } });
    return { message: 'Object deleted successfully.' };
  }

  private assertOwnerOrAdmin(ownerId: string, user: SafeUser): void {
    const isOwner = ownerId === user.id;
    const isAdmin = user.roles.includes(Role.ADMIN);
    if (!isOwner && !isAdmin) throw new ForbiddenException();
  }

  private assertEditable(status: ObjectStatus): void {
    if (status === ObjectStatus.IN_AUCTION || status === ObjectStatus.SOLD) {
      throw new BadRequestException(
        'Cannot modify an object that is in auction or sold.',
      );
    }
  }
}
