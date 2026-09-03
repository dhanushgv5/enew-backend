import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { WishlistService } from './wishlist.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

@Controller('wishlist')
@UseGuards(RolesGuard)
@Roles(Role.CUSTOMER)
export class WishlistController {
  constructor(private wishlistService: WishlistService) {}

  @Get()
  findMine(@CurrentUser('id') userId: string) {
    return this.wishlistService.findMine(userId);
  }

  @Get('ids')
  findMyProductIds(@CurrentUser('id') userId: string) {
    return this.wishlistService.findMyProductIds(userId);
  }

  // No request body on either of these - the product ID lives in the URL,
  // so ParseUUIDPipe (not a DTO) is the right tool to validate it before it
  // ever reaches the service/database.
  @Post(':productId')
  add(@CurrentUser('id') userId: string, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.wishlistService.add(userId, productId);
  }

  @Delete(':productId')
  remove(@CurrentUser('id') userId: string, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.wishlistService.remove(userId, productId);
  }
}