import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ImageKit from 'imagekit';
import { EnvVariables } from 'src/types/declartion-mergin';
import type { UploadResponseDTO } from './dto/upload.dto';

const UPLOAD_FOLDER = '/galleryq';

@Injectable()
export class UploadsService {
  private client: ImageKit | null = null;

  constructor(private readonly configService: ConfigService<EnvVariables>) {}

  async uploadImage(file?: Express.Multer.File): Promise<UploadResponseDTO> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const client = this.getClient();

    try {
      const result = await client.upload({
        file: file.buffer,
        fileName: file.originalname,
        folder: UPLOAD_FOLDER,
        useUniqueFileName: true,
      });

      return {
        url: result.url,
        fileId: result.fileId,
        name: result.name,
        thumbnailUrl: result.thumbnailUrl,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Image upload failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  uploadImages(files?: Express.Multer.File[]): Promise<UploadResponseDTO[]> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    return Promise.all(files.map((file) => this.uploadImage(file)));
  }

  async deleteImage(fileId: string): Promise<void> {
    const client = this.getClient();
    try {
      await client.deleteFile(fileId);
    } catch (error) {
      throw new InternalServerErrorException(
        `Image delete failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // يُنشأ مرّة واحدة؛ يرمي خطأً واضحاً إن كانت مفاتيح ImageKit ناقصة
  private getClient(): ImageKit {
    if (this.client) {
      return this.client;
    }

    const publicKey = this.configService.get<string>('IMAGEKIT_PUBLIC_KEY');
    const privateKey = this.configService.get<string>('IMAGEKIT_PRIVATE_KEY');
    const urlEndpoint = this.configService.get<string>('IMAGEKIT_URL_ENDPOINT');

    if (!publicKey || !privateKey || !urlEndpoint) {
      throw new ServiceUnavailableException(
        'ImageKit is not configured. Set IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY and IMAGEKIT_URL_ENDPOINT.',
      );
    }

    this.client = new ImageKit({ publicKey, privateKey, urlEndpoint });
    return this.client;
  }
}
