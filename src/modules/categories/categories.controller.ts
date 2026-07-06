import { Controller, Get } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoryOptionDTO } from './dto/category.dto';
import { IsPublic } from 'src/decorators/public.decorator';
import {
  SwaggerCategoriesTag,
  ApiListCategories,
} from 'src/swagger/categories.swagger';

@SwaggerCategoriesTag()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @IsPublic(true)
  @ApiListCategories()
  list(): CategoryOptionDTO[] {
    return this.categoriesService.list();
  }
}
