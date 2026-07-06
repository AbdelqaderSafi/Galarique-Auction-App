import { Injectable } from '@nestjs/common';
import { Category } from 'generated/prisma/client';
import type { CategoryOptionDTO } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  // التصنيفات ثابتة (enum): value للتخزين، label للعرض
  list(): CategoryOptionDTO[] {
    return Object.values(Category).map((value) => ({
      value,
      label: value.charAt(0) + value.slice(1).toLowerCase(),
    }));
  }
}
