import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { CreateCategoryDTO } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: DatabaseService) {}

  findAll() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }

  async create(data: CreateCategoryDTO) {
    const existing = await this.prisma.category.findUnique({
      where: { name: data.name },
    });

    if (existing) {
      throw new ConflictException('Category name already in use');
    }

    return this.prisma.category.create({ data });
  }
}
