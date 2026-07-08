import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { Role } from 'generated/prisma/client';
import { Roles } from 'src/decorators/roles.decorator';
import { IsPublic } from 'src/decorators/public.decorator';
import { ZodValidationPipe } from 'src/pipes/zod.validation.pipe';
import { AuctionsService } from './auctions.service';
import { UploadsService } from '../uploads/uploads.service';
import {
  AuctionDetailDTO,
  AuctionResponseDTO,
  BrowseAuctionsQueryDTO,
  PaginatedAuctionsDTO,
  RejectAuctionDTO,
  UpdateAuctionDTO,
} from './dto/auctions.dto';
import {
  browseAuctionsQuerySchema,
  createAuctionBodySchema,
  rejectAuctionSchema,
  updateAuctionSchema,
  type CreateAuctionBody,
} from './util/auctions.validation.schema';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB لكل صورة
const MAX_GALLERY = 10;

// multer: صور فقط + حد للحجم (يبقى في الذاكرة ثم يُرفع إلى ImageKit)
const auctionUploadOptions = {
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new BadRequestException('Only image files are allowed'), false);
    }
    cb(null, true);
  },
};
import {
  SwaggerAuctionsTag,
  ApiCreateAuction,
  ApiListMyAuctions,
  ApiUpdateAuction,
  ApiSubmitAuction,
  ApiDeleteAuction,
  ApiCancelAuction,
  ApiBrowseAuctions,
  ApiGetAuction,
  ApiPendingAuctions,
  ApiApproveAuction,
  ApiRejectAuction,
} from 'src/swagger/auctions.swagger';

@SwaggerAuctionsTag()
@Controller('auctions')
export class AuctionsController {
  constructor(
    private readonly auctionsService: AuctionsService,
    private readonly uploads: UploadsService,
  ) {}

  // ---- Public browse (before :id so /admin & /mine aren't captured as ids) ----

  @Get()
  @IsPublic(true)
  @ApiBrowseAuctions()
  browse(
    @Query(new ZodValidationPipe(browseAuctionsQuerySchema))
    query: BrowseAuctionsQueryDTO,
  ): Promise<PaginatedAuctionsDTO> {
    return this.auctionsService.browse(query);
  }

  // ---- Seller ----

  @Post()
  @Roles([Role.SELLER])
  @ApiCreateAuction()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'mainImage', maxCount: 1 },
        { name: 'images', maxCount: MAX_GALLERY },
      ],
      auctionUploadOptions,
    ),
  )
  async create(
    @Req() req: Request,
    @UploadedFiles()
    files: { mainImage?: Express.Multer.File[]; images?: Express.Multer.File[] },
    @Body(new ZodValidationPipe(createAuctionBodySchema)) body: CreateAuctionBody,
  ): Promise<AuctionResponseDTO> {
    const mainFile = files?.mainImage?.[0];
    if (!mainFile) {
      throw new BadRequestException('mainImage file is required');
    }

    // ارفع الملفات إلى ImageKit ثم خزّن الروابط
    const mainImage = (await this.uploads.uploadImage(mainFile)).url;
    const images = files?.images?.length
      ? (await this.uploads.uploadImages(files.images)).map((u) => u.url)
      : [];

    return this.auctionsService.create(req.user!.id, { ...body, mainImage, images });
  }

  @Get('mine')
  @Roles([Role.SELLER])
  @ApiListMyAuctions()
  findMine(@Req() req: Request): Promise<AuctionResponseDTO[]> {
    return this.auctionsService.findMine(req.user!.id);
  }

  // ---- Admin ----

  @Get('admin/pending')
  @Roles([Role.ADMIN])
  @ApiPendingAuctions()
  pending(): Promise<AuctionResponseDTO[]> {
    return this.auctionsService.pendingQueue();
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles([Role.ADMIN])
  @ApiApproveAuction()
  approve(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<AuctionResponseDTO> {
    return this.auctionsService.approve(id, req.user!.id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles([Role.ADMIN])
  @ApiRejectAuction()
  reject(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectAuctionSchema)) dto: RejectAuctionDTO,
  ): Promise<AuctionResponseDTO> {
    return this.auctionsService.reject(id, req.user!.id, dto.reason);
  }

  // ---- Seller (mutations on a specific auction) ----

  @Patch(':id')
  @Roles([Role.SELLER, Role.ADMIN])
  @ApiUpdateAuction()
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAuctionSchema)) dto: UpdateAuctionDTO,
  ): Promise<AuctionResponseDTO> {
    return this.auctionsService.update(id, req.user!, dto);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Roles([Role.SELLER, Role.ADMIN])
  @ApiSubmitAuction()
  submit(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<AuctionResponseDTO> {
    return this.auctionsService.submit(id, req.user!);
  }

  @Delete(':id')
  @Roles([Role.SELLER, Role.ADMIN])
  @ApiDeleteAuction()
  remove(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    return this.auctionsService.remove(id, req.user!);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles([Role.SELLER, Role.ADMIN])
  @ApiCancelAuction()
  cancel(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<AuctionResponseDTO> {
    return this.auctionsService.cancel(id, req.user!);
  }

  // ---- Public detail (last: catch-all :id) ----

  @Get(':id')
  @IsPublic(true)
  @ApiGetAuction()
  findOne(@Param('id') id: string): Promise<AuctionDetailDTO> {
    return this.auctionsService.findPublic(id);
  }
}
