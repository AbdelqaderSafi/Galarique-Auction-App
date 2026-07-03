import {
  BadRequestException,
  Controller,
  Delete,
  Param,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { UploadsService } from './uploads.service';
import type { UploadResponseDTO } from './dto/upload.dto';
import {
  SwaggerUploadsTag,
  ApiUploadImage,
  ApiUploadImages,
  ApiDeleteImage,
} from 'src/swagger/uploads.swagger';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 10;

// يقبل الصور فقط
const imageFileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new BadRequestException('Only image files are allowed'), false);
  }
  cb(null, true);
};

const multerOptions = {
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: imageFileFilter,
};

@SwaggerUploadsTag()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('image')
  @ApiUploadImage()
  @UseInterceptors(FileInterceptor('file', multerOptions))
  uploadImage(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<UploadResponseDTO> {
    return this.uploadsService.uploadImage(file);
  }

  @Post('images')
  @ApiUploadImages()
  @UseInterceptors(FilesInterceptor('files', MAX_FILES, multerOptions))
  uploadImages(
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<UploadResponseDTO[]> {
    return this.uploadsService.uploadImages(files);
  }

  @Delete(':fileId')
  @ApiDeleteImage()
  async deleteImage(
    @Param('fileId') fileId: string,
  ): Promise<{ message: string }> {
    await this.uploadsService.deleteImage(fileId);
    return { message: 'Image deleted successfully.' };
  }
}
