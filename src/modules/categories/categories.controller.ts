import { Body, Controller, Get, Post } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDTO, CategoryResponseDTO } from './dto/category.dto';
import { IsPublic } from 'src/decorators/public.decorator';
import { Roles } from 'src/decorators/roles.decorator';
import { Role } from 'generated/prisma/client';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { createCategorySchema } from './util/category.validation.schema';
import {
  SwaggerCategoriesTag,
  ApiListCategories,
  ApiCreateCategory,
} from 'src/swagger/categories.swagger';

@SwaggerCategoriesTag()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @IsPublic(true)
  @ApiListCategories()
  findAll(): Promise<CategoryResponseDTO[]> {
    return this.categoriesService.findAll();
  }

  @Post()
  @Roles([Role.ADMIN])
  @ApiCreateCategory()
  create(
    @Body(new ZodValidationPipe(createCategorySchema))
    createCategoryDTO: CreateCategoryDTO,
  ): Promise<CategoryResponseDTO> {
    return this.categoriesService.create(createCategoryDTO);
  }
}
