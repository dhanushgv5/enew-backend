import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderAddressDto, UpdateOrderStatusDto, AssignDeliveryDto, UpdateDeliveryStatusDto } from './dto/order.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Role } from '@prisma/client';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  // Only customers can checkout
  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createFromCart(userId, dto);
  }

  // Customer can view their own orders
  @Get()
  findUserOrders(@CurrentUser('id') userId: string) {
    return this.ordersService.findUserOrders(userId);
  }

  // Admin/Super Admin can view all orders
  @Get('admin/all')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAllAdmin() {
    return this.ordersService.findAllAdmin();
  }

  // Delivery boy views orders assigned to them
  @Get('delivery/my')
  @UseGuards(RolesGuard)
  @Roles(Role.DELIVERY_BOY)
  getMyDeliveries(@CurrentUser('id') userId: string) {
    return this.ordersService.getMyDeliveries(userId);
  }

  // Admin/Super Admin assigns a paid/processing order to a delivery boy
  @Post(':id/assign')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  assignDelivery(@Param('id') id: string, @Body() dto: AssignDeliveryDto) {
    return this.ordersService.assignDelivery(id, dto.deliveryBoyId);
  }

  // Delivery boy advances their own assigned order
  @Patch(':id/delivery-status')
  @UseGuards(RolesGuard)
  @Roles(Role.DELIVERY_BOY)
  updateDeliveryStatus(
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryStatusDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.ordersService.updateDeliveryStatus(id, userId, dto.status);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    return this.ordersService.findOne(id, userId, role);
  }

  // Customer edits the shipping address on their own order, before it ships
  @Patch(':id/address')
  @UseGuards(RolesGuard)
  @Roles(Role.CUSTOMER)
  updateAddress(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateOrderAddressDto,
  ) {
    return this.ordersService.updateShippingAddress(id, userId, dto);
  }

  @Patch(':id/status')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.CUSTOMER)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: Role,
  ) {
    return this.ordersService.updateStatus(id, dto, role, userId);
  }

  // Admin/Super Admin can simulate payment
  @Post(':id/pay')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  markPaid(@Param('id') id: string) {
    return this.ordersService.markAsPaid(
      id,
      `pi_simulated_${Date.now()}`,
    );
  }
}