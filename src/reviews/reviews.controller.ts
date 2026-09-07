import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { Role } from '@prisma/client';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto, QueryReviewsDto, UpdateReviewDto } from './dto/review.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per photo
const MAX_PHOTOS_PER_UPLOAD = 5;

@Controller('reviews')
export class ReviewsController {
  constructor(private reviewsService: ReviewsService) {}

  // Customer uploads one or more photos first, gets back URLs, then submits
  // those URLs as part of CreateReviewDto.photos.
  @Post('photos')
  @Roles(Role.CUSTOMER)
  @UseGuards(RolesGuard)
  @UseInterceptors(
    FilesInterceptor('photos', MAX_PHOTOS_PER_UPLOAD, {
      storage: diskStorage({
        destination: './uploads/reviews',
        filename: (_req: Express.Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: MAX_PHOTO_SIZE_BYTES },
      fileFilter: (_req: Express.Request, file: Express.Multer.File, cb: (error: Error | null, acceptFile: boolean) => void) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(new BadRequestException('Only JPEG, PNG, or WEBP images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadPhotos(@UploadedFiles() files: any[]) {
    if (!files?.length) {
      throw new BadRequestException('No photos uploaded');
    }
    return {
      urls: files.map((f) => `/uploads/reviews/${f.filename}`),
    };
  }

  // Public: list reviews + rating summary for a product
  @Public()
  @Get('product/:productId')
  findByProduct(@Param('productId') productId: string, @Query() query: QueryReviewsDto) {
    return this.reviewsService.findByProduct(productId, query);
  }

  // Public: just the rating summary (average + distribution) for a product
  @Public()
  @Get('product/:productId/summary')
  getSummary(@Param('productId') productId: string) {
    return this.reviewsService.getSummary(productId);
  }

  // Customer: check whether they've already reviewed a product (to show edit vs create in UI)
  @Get('mine/:productId')
  findMine(@CurrentUser('id') userId: string, @Param('productId') productId: string) {
    return this.reviewsService.findMine(userId, productId);
  }

  // Admin/Super Admin: browse all reviews, optionally filtered by product
  @Get('admin/all')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllAdmin(@Query() query: QueryReviewsDto) {
    return this.reviewsService.findAllAdmin(query);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(userId, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviewsService.update(id, userId, role, dto);
  }

  // Owner can delete their own review; Admin/Super Admin can moderate any review
  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    return this.reviewsService.remove(id, userId, role);
  }
}