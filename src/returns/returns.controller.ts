import {
  BadRequestException,
  Body,
  Controller,
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
import { ReturnsService } from './returns.service';
import {
  CreateReturnRequestDto,
  QueryReturnsDto,
  SchedulePickupDto,
  UpdateReturnDeliveryStatusDto,
  UpdateReturnStatusDto,
} from './dto/return.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per photo
const MAX_PHOTOS_PER_UPLOAD = 5;

@Controller('returns')
@UseGuards(JwtAuthGuard)
export class ReturnsController {
  constructor(private returnsService: ReturnsService) {}

  // Customer uploads proof photos first, gets back URLs, then submits those
  // URLs as part of CreateReturnRequestDto.photos.
  @Post('photos')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  @UseInterceptors(
    FilesInterceptor('photos', MAX_PHOTOS_PER_UPLOAD, {
      storage: diskStorage({
        destination: './uploads/returns',
        filename: (_req, file: any, cb) => {
          const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: MAX_PHOTO_SIZE_BYTES },
      fileFilter: (_req, file: any, cb) => {
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
      urls: files.map((f) => `/uploads/returns/${f.filename}`),
    };
  }

  // Customer requests a return or replacement for a delivered item
  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateReturnRequestDto) {
    return this.returnsService.create(userId, dto);
  }

  // Customer views their own return/replacement requests
  @Get('mine')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  findMine(@CurrentUser('id') userId: string, @Query() query: QueryReturnsDto) {
    return this.returnsService.findMine(userId, query);
  }

  // Admin/Super Admin browses all requests, optionally filtered
  @Get('admin/all')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllAdmin(@Query() query: QueryReturnsDto) {
    return this.returnsService.findAllAdmin(query);
  }

  // Delivery boy's own assigned pickups
  @Get('delivery/mine')
  @UseGuards(RolesGuard)
  @Roles(Role.DELIVERY_BOY)
  findMyPickups(@CurrentUser('id') deliveryBoyId: string) {
    return this.returnsService.findMyPickups(deliveryBoyId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    return this.returnsService.findOne(id, userId, role);
  }

  // Customer withdraws their own request before pickup
  @Patch(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  cancel(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.returnsService.cancel(id, userId);
  }

  // Admin/Super Admin approves/rejects/finalizes a request
  @Patch(':id/status')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateStatus(@Param('id') id: string, @Body() dto: UpdateReturnStatusDto) {
    return this.returnsService.updateStatus(id, dto);
  }

  // Admin/Super Admin schedules a pickup date + assigns a delivery boy
  @Patch(':id/schedule-pickup')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  schedulePickup(@Param('id') id: string, @Body() dto: SchedulePickupDto) {
    return this.returnsService.schedulePickup(id, dto);
  }

  // Delivery boy advances a pickup assigned to them
  @Patch(':id/delivery-status')
  @UseGuards(RolesGuard)
  @Roles(Role.DELIVERY_BOY)
  updateDeliveryStatus(
    @Param('id') id: string,
    @CurrentUser('id') deliveryBoyId: string,
    @Body() dto: UpdateReturnDeliveryStatusDto,
  ) {
    return this.returnsService.updateDeliveryStatus(id, deliveryBoyId, dto);
  }
}
