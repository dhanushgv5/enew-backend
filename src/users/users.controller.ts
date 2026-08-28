import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateDeliveryBoyDto } from './dto/create-delivery-boy.dto';
import { UpdateDeliveryBoyDto } from './dto/update-delivery-boy.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Role } from '@prisma/client';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  getProfile(@CurrentUser('id') userId: string) {
    return this.usersService.getProfile(userId);
  }

  // Self-service profile edit (name, phone) - any logged-in user, any role
  @Patch('me')
  updateProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(userId, dto);
  }

  // Self-service password change - requires current password
  @Patch('me/password')
  changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(userId, dto);
  }

  // Admin/Super Admin manage delivery boy accounts
  @Post('delivery-boys')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  createDeliveryBoy(@Body() dto: CreateDeliveryBoyDto) {
    return this.usersService.createDeliveryBoy(dto);
  }

  @Get('delivery-boys')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findDeliveryBoys() {
    return this.usersService.findDeliveryBoys();
  }

  @Patch('delivery-boys/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateDeliveryBoy(@Param('id') id: string, @Body() dto: UpdateDeliveryBoyDto) {
    return this.usersService.updateDeliveryBoy(id, dto);
  }

  // Soft delete (deactivate) - see comment on the service method for why.
  @Delete('delivery-boys/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deactivateDeliveryBoy(@Param('id') id: string) {
    return this.usersService.deactivateDeliveryBoy(id);
  }
}
