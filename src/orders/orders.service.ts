import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { CartService } from '../cart/cart.service';
import { EventsGateway } from '../websocket/events.gateway';
import { CreateOrderDto, UpdateOrderAddressDto, UpdateOrderStatusDto } from './dto/order.dto';
import { OrderStatus, Prisma, Role } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: [OrderStatus.PAID, OrderStatus.CANCELLED],
  PAID: [OrderStatus.PROCESSING, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  PROCESSING: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  SHIPPED: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CANCELLED],
  OUT_FOR_DELIVERY: [OrderStatus.DELIVERED],
  DELIVERED: [OrderStatus.REFUNDED],
  CANCELLED: [],
  REFUNDED: [],
};

// Statuses a customer is allowed to cancel from. Cancellation is cut off
// once the order reaches OUT_FOR_DELIVERY - by then the courier already
// has the package in hand, so it can't be pulled back the same way.
const CUSTOMER_CANCELLABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
];

// The delivery boy's own progression, enforced separately from
// VALID_TRANSITIONS/updateStatus above since it has a different
// authorization rule (must own the assignment, not just hold a role).
const DELIVERY_TRANSITIONS: Record<string, OrderStatus[]> = {
  SHIPPED: [OrderStatus.OUT_FOR_DELIVERY],
  OUT_FOR_DELIVERY: [OrderStatus.DELIVERED],
};

// Once an order is SHIPPED the label is already printed and the courier has
// it, so the shipping address can no longer be changed by the customer.
const ADDRESS_EDITABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
];

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private productsService: ProductsService,
    private cartService: CartService,
    private eventsGateway: EventsGateway,
  ) {}

  async createFromCart(userId: string, dto: CreateOrderDto) {
    const cart = await this.cartService.getCart(userId);

    if (!cart.items.length) {
      throw new BadRequestException('Cart is empty');
    }

    // Validate stock again
    for (const item of cart.items) {
      if (!item.product.isActive) {
        throw new BadRequestException(`Product ${item.product.name} is no longer available`);
      }
      if (item.available < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for ${item.product.name}. Only ${item.available} left.`,
        );
      }
    }

    const orderNumber = `ORD-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    // Transaction: reserve stock + create order
    const order = await this.prisma.$transaction(async (tx) => {
      // Reserve stock for all items
      for (const item of cart.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
        });
        if (!product) throw new NotFoundException('Product missing');

        const available = product.stock - product.reservedStock;
        if (available < item.quantity) {
          throw new BadRequestException(`Stock changed for ${product.name}`);
        }

        await tx.product.update({
          where: { id: item.productId },
          data: { reservedStock: { increment: item.quantity } },
        });
      }

      const subtotal = cart.subtotal;
      const tax = subtotal.mul(0.1); // 10% tax example
      const shipping = new Prisma.Decimal(9.99);
      const total = subtotal.add(tax).add(shipping);

      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          userId,
          status: OrderStatus.PENDING,
          subtotal,
          tax,
          shipping,
          total,
          shippingAddress: dto.shippingAddress,
          billingAddress: dto.billingAddress || dto.shippingAddress,
          items: {
            create: cart.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              price: item.product.price,
              name: item.product.name,
            })),
          },
          statusHistory: {
            create: {
              status: OrderStatus.PENDING,
              note: 'Order created',
            },
          },
        },
        include: {
          items: true,
          statusHistory: true,
        },
      });

      // Clear cart
      await tx.cartItem.deleteMany({
        where: { cartId: cart.id },
      });

      return newOrder;
    });

    return order;
  }

  /**
   * Mark order as paid (called after payment webhook in real app)
   * Confirms stock (moves from reserved to sold)
   */
  async markAsPaid(orderId: string, paymentIntentId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });

      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== OrderStatus.PENDING) {
        throw new BadRequestException('Order is not in PENDING state');
      }

      // Confirm stock
      for (const item of order.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stock: { decrement: item.quantity },
            reservedStock: { decrement: item.quantity },
          },
        });
      }

      return tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.PAID,
          paymentIntentId,
          statusHistory: {
            create: {
              status: OrderStatus.PAID,
              note: 'Payment confirmed',
            },
          },
        },
        include: { items: true, statusHistory: true },
      });
    });
  }

  async updateStatus(
    orderId: string,
    dto: UpdateOrderStatusDto,
    userRole: Role,
    userId: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');

    // Customers can cancel their own order any time before it's out for
    // delivery - once a courier has it, cancellation is no longer allowed.
    if (userRole === Role.CUSTOMER) {
      if (order.userId !== userId) {
        throw new ForbiddenException();
      }
      if (
        dto.status !== OrderStatus.CANCELLED ||
        !CUSTOMER_CANCELLABLE_STATUSES.includes(order.status)
      ) {
        throw new ForbiddenException(
          'You can only cancel an order before it is out for delivery',
        );
      }
    }

    const allowed = VALID_TRANSITIONS[order.status] || [];
    if (!allowed.includes(dto.status as OrderStatus)) {
      throw new BadRequestException(
        `Cannot transition from ${order.status} to ${dto.status}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // If cancelling, release/restore stock depending on the order's previous status.
      if (dto.status === OrderStatus.CANCELLED) {
        const items = await tx.orderItem.findMany({ where: { orderId } });

        if (order.status === OrderStatus.PENDING) {
          // Stock was only ever reserved, never decremented - release the reservation.
          for (const item of items) {
            await tx.product.update({
              where: { id: item.productId },
              data: { reservedStock: { decrement: item.quantity } },
            });
          }
        } else if (
          order.status === OrderStatus.PAID ||
          order.status === OrderStatus.PROCESSING ||
          order.status === OrderStatus.SHIPPED
        ) {
          // markAsPaid already decremented both stock and reservedStock -
          // cancelling now means putting the sold inventory back.
          for (const item of items) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } },
            });
          }
        }
      }

      return tx.order.update({
        where: { id: orderId },
        data: {
          status: dto.status as OrderStatus,
          ...(dto.status === OrderStatus.DELIVERED && { deliveredAt: new Date() }),
          statusHistory: {
            create: {
              status: dto.status as OrderStatus,
              note: dto.note,
            },
          },
        },
        include: { items: true, statusHistory: true },
      });
    });
  }

  async findUserOrders(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      include: {
        items: {
          include: { product: { select: { images: true, slug: true } } },
        },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(orderId: string, userId: string, role: Role) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: { select: { images: true, slug: true } } } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        user: { select: { email: true, firstName: true, lastName: true } },
      },
    });

    if (!order) throw new NotFoundException('Order not found');

    if (role === Role.CUSTOMER && order.userId !== userId) {
      throw new ForbiddenException();
    }
    if (role === Role.DELIVERY_BOY && order.deliveryBoyId !== userId) {
      throw new ForbiddenException();
    }

    return order;
  }

  /**
   * Customer edits the shipping address on an order they've already placed.
   * Only allowed before the order ships - once a courier has the label
   * printed, the destination can't move.
   */
  async updateShippingAddress(orderId: string, userId: string, dto: UpdateOrderAddressDto) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    if (order.userId !== userId) {
      throw new ForbiddenException();
    }

    if (!ADDRESS_EDITABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        'This order has already shipped and its address can no longer be changed',
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        shippingAddress: dto.shippingAddress,
        statusHistory: {
          create: {
            status: order.status,
            note: 'Shipping address updated by customer',
          },
        },
      },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        deliveryBoy: { select: { id: true, email: true, firstName: true } },
      },
    });

    // Push the change live to the customer's other open tabs/devices and to
    // any admin dashboard currently open, so nobody has to refresh to see it.
    this.eventsGateway.emitOrderUpdate(userId, updated);

    return updated;
  }

  async findAllAdmin() {
    return this.prisma.order.findMany({
      include: {
        user: { select: { email: true, firstName: true } },
        deliveryBoy: { select: { id: true, email: true, firstName: true, lastName: true } },
        items: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Admin assigns a paid/processing order to a delivery boy.
   * Moves the order to SHIPPED - "shipped" here means "handed to courier",
   * not that it's physically left the building yet.
   */
  async assignDelivery(orderId: string, deliveryBoyId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

   const eligibleStatuses: OrderStatus[] = [OrderStatus.PAID, OrderStatus.PROCESSING];
if (!eligibleStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Cannot assign delivery for an order in ${order.status} status`,
      );
    }

    const deliveryBoy = await this.prisma.user.findUnique({
      where: { id: deliveryBoyId },
    });
    if (
      !deliveryBoy ||
      deliveryBoy.role !== Role.DELIVERY_BOY ||
      !deliveryBoy.isActive
    ) {
      throw new BadRequestException('Invalid or inactive delivery boy');
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        deliveryBoyId,
        status: OrderStatus.SHIPPED,
        statusHistory: {
          create: {
            status: OrderStatus.SHIPPED,
            note: `Assigned to delivery partner`,
          },
        },
      },
      include: {
        items: true,
        statusHistory: true,
        deliveryBoy: { select: { id: true, email: true, firstName: true } },
      },
    });
  }

  /** Orders currently or previously assigned to this delivery boy. */
  async getMyDeliveries(deliveryBoyId: string) {
    return this.prisma.order.findMany({
      where: { deliveryBoyId },
      include: {
        items: true,
        user: { select: { firstName: true, lastName: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Delivery boy advances their own assigned order. Separate from the
   * generic updateStatus() above because the authorization rule is
   * different: must own the assignment, not just hold a role.
   */
  async updateDeliveryStatus(
    orderId: string,
    deliveryBoyId: string,
    newStatus: 'OUT_FOR_DELIVERY' | 'DELIVERED',
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    if (order.deliveryBoyId !== deliveryBoyId) {
      throw new ForbiddenException('This order is not assigned to you');
    }

    const allowed = DELIVERY_TRANSITIONS[order.status] || [];
    if (!allowed.includes(newStatus as OrderStatus)) {
      throw new BadRequestException(
        `Cannot move from ${order.status} to ${newStatus}`,
      );
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: newStatus as OrderStatus,
        ...(newStatus === 'DELIVERED' && { deliveredAt: new Date() }),
        statusHistory: {
          create: {
            status: newStatus as OrderStatus,
            note:
              newStatus === 'OUT_FOR_DELIVERY'
                ? 'Out for delivery'
                : 'Delivered to customer',
          },
        },
      },
      include: { items: true, statusHistory: true },
    });
  }
}