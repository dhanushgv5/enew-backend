import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, ReturnStatus, ReturnType, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../websocket/events.gateway';
import {
  CreateReturnRequestDto,
  QueryReturnsDto,
  SchedulePickupDto,
  UpdateReturnDeliveryStatusDto,
  UpdateReturnStatusDto,
} from './dto/return.dto';

// How many days after delivery a customer may still request a return/replacement.
const RETURN_WINDOW_DAYS = 7;

// Customer can cancel their own request any time before the item has
// actually been picked up - once it's in transit back, it's out of their hands.
const CUSTOMER_CANCELLABLE_STATUSES: ReturnStatus[] = [
  ReturnStatus.REQUESTED,
  ReturnStatus.APPROVED,
  ReturnStatus.PICKUP_SCHEDULED,
];

// Transitions the admin drives directly via PATCH /returns/:id/status.
// PICKUP_SCHEDULED is deliberately excluded here - that handoff always goes
// through schedulePickup() below, since it requires a date + a delivery boy.
// PICKED_UP and RECEIVED are also excluded - once a pickup is scheduled, the
// assigned delivery boy is the one who moves the request through those two
// steps (mirrors how OUT_FOR_DELIVERY/DELIVERED work for orders).
const ADMIN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  REQUESTED: [ReturnStatus.APPROVED, ReturnStatus.REJECTED, ReturnStatus.CANCELLED],
  APPROVED: [ReturnStatus.CANCELLED],
  PICKUP_SCHEDULED: [ReturnStatus.CANCELLED],
  PICKED_UP: [],
  RECEIVED: [ReturnStatus.REFUNDED, ReturnStatus.REPLACED],
  REJECTED: [],
  REFUNDED: [],
  REPLACED: [],
  CANCELLED: [],
};

// Transitions the assigned delivery boy drives via PATCH /returns/:id/delivery-status.
const DELIVERY_TRANSITIONS: Partial<Record<ReturnStatus, ReturnStatus[]>> = {
  PICKUP_SCHEDULED: [ReturnStatus.PICKED_UP],
  PICKED_UP: [ReturnStatus.RECEIVED],
};

const ORDER_ITEM_INCLUDE = {
  orderItem: { include: { product: { select: { id: true, name: true, images: true, slug: true } } } },
  order: { select: { id: true, orderNumber: true, status: true, deliveredAt: true } },
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
  deliveryBoy: { select: { id: true, email: true, firstName: true, lastName: true, phone: true } },
  statusHistory: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.ReturnRequestInclude;

@Injectable()
export class ReturnsService {
  constructor(
    private prisma: PrismaService,
    private eventsGateway: EventsGateway,
  ) {}

  async create(userId: string, dto: CreateReturnRequestDto) {
    const orderItem = await this.prisma.orderItem.findUnique({
      where: { id: dto.orderItemId },
      include: {
        order: true,
        returnRequests: {
          where: { status: { notIn: [ReturnStatus.REJECTED, ReturnStatus.CANCELLED] } },
        },
      },
    });
    if (!orderItem) throw new NotFoundException('Order item not found');

    if (orderItem.order.userId !== userId) {
      throw new ForbiddenException();
    }

    if (orderItem.order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException('This order has not been delivered yet');
    }

    if (orderItem.order.deliveredAt) {
      const deadline = new Date(orderItem.order.deliveredAt);
      deadline.setDate(deadline.getDate() + RETURN_WINDOW_DAYS);
      if (new Date() > deadline) {
        throw new BadRequestException(
          `The return window (${RETURN_WINDOW_DAYS} days after delivery) for this item has passed`,
        );
      }
    }

    const alreadyRequested = orderItem.returnRequests.reduce((sum, r) => sum + r.quantity, 0);
    if (alreadyRequested + dto.quantity > orderItem.quantity) {
      throw new BadRequestException(
        `You can only request ${orderItem.quantity - alreadyRequested} more unit(s) of this item`,
      );
    }

    const created = await this.prisma.returnRequest.create({
      data: {
        orderId: orderItem.orderId,
        orderItemId: dto.orderItemId,
        userId,
        type: dto.type as ReturnType,
        quantity: dto.quantity,
        reason: dto.reason,
        description: dto.description,
        photos: dto.photos || [],
        statusHistory: {
          create: { status: ReturnStatus.REQUESTED, note: 'Request submitted' },
        },
      },
      include: ORDER_ITEM_INCLUDE,
    });

    this.eventsGateway.emitReturnUpdate(userId, created);
    return created;
  }

  async findMine(userId: string, query: QueryReturnsDto) {
    return this.prisma.returnRequest.findMany({
      where: {
        userId,
        ...(query.status && { status: query.status }),
        ...(query.type && { type: query.type }),
        ...(query.orderId && { orderId: query.orderId }),
      },
      include: ORDER_ITEM_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllAdmin(query: QueryReturnsDto) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where = {
      ...(query.status && { status: query.status }),
      ...(query.type && { type: query.type }),
      ...(query.orderId && { orderId: query.orderId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.returnRequest.findMany({
        where,
        include: ORDER_ITEM_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.returnRequest.count({ where }),
    ]);

    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, userId: string, role: Role) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id },
      include: ORDER_ITEM_INCLUDE,
    });
    if (!request) throw new NotFoundException('Return request not found');

    if (role === Role.CUSTOMER && request.userId !== userId) {
      throw new ForbiddenException();
    }
    return request;
  }

  // Customer withdraws their own request before it's been picked up.
  async cancel(id: string, userId: string) {
    const request = await this.prisma.returnRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Return request not found');
    if (request.userId !== userId) throw new ForbiddenException();

    if (!CUSTOMER_CANCELLABLE_STATUSES.includes(request.status)) {
      throw new BadRequestException(
        'This request can no longer be cancelled - it is already being processed',
      );
    }

    const updated = await this.prisma.returnRequest.update({
      where: { id },
      data: {
        status: ReturnStatus.CANCELLED,
        statusHistory: {
          create: { status: ReturnStatus.CANCELLED, note: 'Cancelled by customer' },
        },
      },
      include: ORDER_ITEM_INCLUDE,
    });

    this.eventsGateway.emitReturnUpdate(userId, updated);
    return updated;
  }

  // Admin/Super Admin approves, rejects, or finalizes a request. Does not
  // handle the pickup handoff (see schedulePickup) or the pickup/received
  // steps (see updateDeliveryStatus) - those belong to the delivery boy.
  async updateStatus(id: string, dto: UpdateReturnStatusDto) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id },
      include: { orderItem: true },
    });
    if (!request) throw new NotFoundException('Return request not found');

    const nextStatus = dto.status as ReturnStatus;
    const allowed = ADMIN_TRANSITIONS[request.status] || [];
    if (!allowed.includes(nextStatus)) {
      throw new BadRequestException(
        nextStatus === ReturnStatus.PICKUP_SCHEDULED
          ? 'Scheduling a pickup requires a date and a delivery boy - use the schedule-pickup action instead'
          : `Cannot move a request from ${request.status} to ${nextStatus}`,
      );
    }

    if (nextStatus === ReturnStatus.REFUNDED && request.type !== ReturnType.RETURN) {
      throw new BadRequestException('Only RETURN requests can be marked REFUNDED');
    }
    if (nextStatus === ReturnStatus.REPLACED && request.type !== ReturnType.REPLACEMENT) {
      throw new BadRequestException('Only REPLACEMENT requests can be marked REPLACED');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // A replacement unit ships out to the customer - take it back out of stock.
      if (nextStatus === ReturnStatus.REPLACED) {
        await tx.product.update({
          where: { id: request.orderItem.productId },
          data: { stock: { decrement: request.quantity } },
        });
      }

      const refundAmount =
        nextStatus === ReturnStatus.REFUNDED
          ? new Prisma.Decimal(dto.refundAmount ?? Number(request.orderItem.price) * request.quantity)
          : undefined;

      return tx.returnRequest.update({
        where: { id },
        data: {
          status: nextStatus,
          adminNote: dto.note,
          ...(refundAmount !== undefined && { refundAmount }),
          statusHistory: {
            create: { status: nextStatus, note: dto.note },
          },
        },
        include: ORDER_ITEM_INCLUDE,
      });
    });

    this.eventsGateway.emitReturnUpdate(request.userId, updated);
    return updated;
  }

  // Admin schedules the pickup: picks a date and hands the request off to a
  // delivery boy. Only valid once the request has been APPROVED.
  async schedulePickup(id: string, dto: SchedulePickupDto) {
    const request = await this.prisma.returnRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Return request not found');

    if (request.status !== ReturnStatus.APPROVED) {
      throw new BadRequestException(
        'A pickup can only be scheduled for a request that has been approved',
      );
    }

    const deliveryBoy = await this.prisma.user.findUnique({
      where: { id: dto.deliveryBoyId },
      select: { id: true, role: true, isActive: true },
    });
    if (!deliveryBoy || deliveryBoy.role !== Role.DELIVERY_BOY) {
      throw new BadRequestException('Selected user is not a delivery boy');
    }
    if (!deliveryBoy.isActive) {
      throw new BadRequestException('Selected delivery boy is not active');
    }

    const pickupDate = new Date(dto.pickupDate);

    const updated = await this.prisma.returnRequest.update({
      where: { id },
      data: {
        status: ReturnStatus.PICKUP_SCHEDULED,
        deliveryBoyId: dto.deliveryBoyId,
        pickupDate,
        statusHistory: {
          create: {
            status: ReturnStatus.PICKUP_SCHEDULED,
            note: dto.note || `Pickup scheduled for ${pickupDate.toLocaleDateString()}`,
          },
        },
      },
      include: ORDER_ITEM_INCLUDE,
    });

    this.eventsGateway.emitReturnUpdate(request.userId, updated);
    // Let the assigned delivery boy know a pickup just landed on their plate.
    this.eventsGateway.emitReturnUpdate(dto.deliveryBoyId, updated);
    return updated;
  }

  // Delivery boy advances a pickup they've been assigned: PICKUP_SCHEDULED
  // -> PICKED_UP -> RECEIVED (mirrors OrdersService.updateDeliveryStatus).
  async updateDeliveryStatus(id: string, deliveryBoyId: string, dto: UpdateReturnDeliveryStatusDto) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { id },
      include: { orderItem: true },
    });
    if (!request) throw new NotFoundException('Return request not found');

    if (request.deliveryBoyId !== deliveryBoyId) {
      throw new ForbiddenException('This pickup is not assigned to you');
    }

    const nextStatus = dto.status as ReturnStatus;
    const allowed = DELIVERY_TRANSITIONS[request.status] || [];
    if (!allowed.includes(nextStatus)) {
      throw new BadRequestException(`Cannot move a pickup from ${request.status} to ${nextStatus}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Item physically confirmed back in the warehouse - return it to sellable stock.
      if (nextStatus === ReturnStatus.RECEIVED) {
        await tx.product.update({
          where: { id: request.orderItem.productId },
          data: { stock: { increment: request.quantity } },
        });
      }

      return tx.returnRequest.update({
        where: { id },
        data: {
          status: nextStatus,
          statusHistory: {
            create: {
              status: nextStatus,
              note:
                nextStatus === ReturnStatus.PICKED_UP
                  ? 'Picked up from customer'
                  : 'Received at warehouse',
            },
          },
        },
        include: ORDER_ITEM_INCLUDE,
      });
    });

    this.eventsGateway.emitReturnUpdate(request.userId, updated);
    return updated;
  }

  // Delivery boy's own assigned pickups.
  async findMyPickups(deliveryBoyId: string) {
    return this.prisma.returnRequest.findMany({
      where: { deliveryBoyId },
      include: ORDER_ITEM_INCLUDE,
      orderBy: { pickupDate: 'asc' },
    });
  }
}
