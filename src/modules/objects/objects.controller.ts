import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Role } from 'generated/prisma/client';
import { Roles } from 'src/decorators/roles.decorator';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { ObjectsService } from './objects.service';
import {
  CreateObjectDTO,
  ObjectResponseDTO,
  UpdateObjectDTO,
} from './dto/objects.dto';
import {
  createObjectSchema,
  updateObjectSchema,
} from './util/objects.validation.schema';
import {
  SwaggerObjectsTag,
  ApiCreateObject,
  ApiListMyObjects,
  ApiGetObject,
  ApiUpdateObject,
  ApiDeleteObject,
} from 'src/swagger/objects.swagger';

@SwaggerObjectsTag()
@Controller('objects')
export class ObjectsController {
  constructor(private readonly objectsService: ObjectsService) {}

  @Post()
  @Roles([Role.SELLER])
  @ApiCreateObject()
  create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createObjectSchema)) dto: CreateObjectDTO,
  ): Promise<ObjectResponseDTO> {
    return this.objectsService.create(req.user!.id, dto);
  }

  @Get('mine')
  @Roles([Role.SELLER])
  @ApiListMyObjects()
  findMine(@Req() req: Request): Promise<ObjectResponseDTO[]> {
    return this.objectsService.findMine(req.user!.id);
  }

  @Get(':id')
  @ApiGetObject()
  findOne(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<ObjectResponseDTO> {
    return this.objectsService.findOne(id, req.user!);
  }

  @Patch(':id')
  @ApiUpdateObject()
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateObjectSchema)) dto: UpdateObjectDTO,
  ): Promise<ObjectResponseDTO> {
    return this.objectsService.update(id, req.user!, dto);
  }

  @Delete(':id')
  @ApiDeleteObject()
  remove(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    return this.objectsService.remove(id, req.user!);
  }
}
