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
import { CreateOrderDto, UpdateOrderAddressDto, UpdateOrderStatusDto, VerifyRazorpayPaymentDto } from './dto/order.dto';
import { OrderStatus, Prisma, Role } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import Razorpay from 'razorpay';
import * as crypto from 'crypto';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // PAID is intentionally not reachable from here - the only paths into
  // PAID are markAsPaid (via the admin /pay simulate endpoint, the customer
  // /razorpay/verify endpoint, or the Razorpay webhook), all of which run
  // the stock-confirm logic (reserved -> sold) that this generic transition
  // does not. Allowing PENDING -> PAID here would let an order become PAID
  // without ever releasing/confirming its reserved stock.
  PENDING: [OrderStatus.CANCELLED],
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
  // Constructed lazily on first use rather than as a class field, so a
  // missing RAZORPAY_KEY_ID/SECRET only breaks payment endpoints, not the
  // whole module (createFromCart etc. still work without keys set).
  private razorpay: Razorpay | null = null;

  constructor(
    private prisma: PrismaService,
    private productsService: ProductsService,
    private cartService: CartService,
    private eventsGateway: EventsGateway,
  ) {}

  private getRazorpay(): Razorpay {
    if (!this.razorpay) {
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new BadRequestException('Razorpay is not configured on the server');
      }
      this.razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
    }
    return this.razorpay;
  }

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
      // Reserve stock for all items. SELECT ... FOR UPDATE locks each
      // product row for the rest of this transaction, so a concurrent
      // request reserving the same product blocks here until this
      // transaction commits (or rolls back) instead of reading a stale
      // stock/reservedStock pair - without this lock, two requests can
      // both read "1 available" for the last unit and both reserve it.
      for (const item of cart.items) {
        const rows = await tx.$queryRaw<
          { id: string; name: string; stock: number; reservedStock: number }[]
        >`SELECT id, name, stock, "reservedStock" FROM products WHERE id = ${item.productId} FOR UPDATE`;
        const product = rows[0];
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
   * Mark order as paid - called from the customer's /verify request and
   * from the Razorpay webhook, whichever gets there first.
   * Confirms stock (moves from reserved to sold).
   *
   * The PENDING -> PAID transition is claimed atomically via updateMany's
   * WHERE clause (id + status=PENDING) before any stock is touched: if a
   * concurrent call already claimed it, this update matches zero rows and
   * we stop immediately, rather than racing another call to decrement the
   * same stock twice.
   */
  async markAsPaid(
    orderId: string,
    paymentIntentId?: string,
    razorpayPaymentId?: string,
    razorpaySignature?: string,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: {
          status: OrderStatus.PAID,
          paymentIntentId,
          ...(razorpayPaymentId && { razorpayPaymentId }),
          ...(razorpaySignature && { razorpaySignature }),
        },
      });

      if (claim.count === 0) {
        const existing = await tx.order.findUnique({ where: { id: orderId } });
        if (!existing) throw new NotFoundException('Order not found');
        throw new BadRequestException('Order is not in PENDING state');
      }

      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });

      // Confirm stock now that we've atomically won the PENDING -> PAID claim.
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

    // markAsPaid previously updated the DB silently - push it live too,
    // same as updateShippingAddress does, so the order page and admin
    // console update without a manual refresh.
    this.eventsGateway.emitOrderUpdate(updated.userId, updated);
    return updated;
  }

  /**
   * Step 1 of customer checkout: create a Razorpay order for an existing
   * PENDING order and hand the frontend what it needs to open Checkout.js.
   */
  async createRazorpayOrder(orderId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Order is not payable in its current state');
    }

    // amount in paise
    const amountPaise = Math.round(Number(order.total) * 100);

    // Idempotency: if we already created a Razorpay order for this order
    // (e.g. the customer clicked "Pay now" again, or has two tabs open),
    // reuse it instead of minting a new one. Otherwise a second call here
    // overwrites razorpayOrderId, and if the customer completes payment on
    // the *first* checkout window, verifyRazorpayPayment's mismatch check
    // rejects that legitimate payment.
    if (order.razorpayOrderId) {
      try {
        const existing = await this.getRazorpay().orders.fetch(order.razorpayOrderId);
        if (existing && existing.status !== 'paid') {
          return {
            razorpayOrderId: existing.id,
            amount: existing.amount,
            currency: existing.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
          };
        }
      } catch {
        // Stale/expired id on Razorpay's side - fall through and create a fresh one.
      }
    }

    const rzpOrder = await this.getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: order.orderNumber,
      notes: { orderId: order.id, userId },
    });

    await this.prisma.order.update({
      where: { id: order.id },
      data: { razorpayOrderId: rzpOrder.id },
    });

    return {
      razorpayOrderId: rzpOrder.id,
      amount: amountPaise,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
    };
  }

  /**
   * Step 2: verify the signature Checkout.js's success handler returns,
   * then confirm the order the same way markAsPaid does (stock reserved
   * -> sold, status PENDING -> PAID). The razorpayPaymentId/Signature are
   * written atomically as part of markAsPaid's guarded transaction rather
   * than in a separate call, so a concurrent duplicate /verify can't slip
   * a write in between the check and the claim.
   */
  async verifyRazorpayPayment(orderId: string, userId: string, dto: VerifyRazorpayPaymentDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.razorpayOrderId || order.razorpayOrderId !== dto.razorpayOrderId) {
      throw new BadRequestException('Razorpay order mismatch');
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Order is not in PENDING state');
    }

    const body = `${dto.razorpayOrderId}|${dto.razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(body)
      .digest('hex');

    if (expectedSignature !== dto.razorpaySignature) {
      throw new BadRequestException('Payment signature verification failed');
    }

    return this.markAsPaid(order.id, dto.razorpayPaymentId, dto.razorpayPaymentId, dto.razorpaySignature);
  }

  /**
   * Razorpay calls this server-to-server the moment a payment is captured.
   * This is the source of truth for marking an order PAID - independent of
   * whether the customer's browser ever completes the /verify call above
   * (tab closed, network dropped, app backgrounded). Idempotent: repeated
   * deliveries of the same event (Razorpay retries on anything but a 2xx)
   * just find the order already PAID and acknowledge without reprocessing.
   */
  async handleRazorpayWebhook(rawBody: Buffer, signature: string) {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      throw new BadRequestException('Webhook secret not configured on the server');
    }
    if (!signature) {
      throw new BadRequestException('Missing webhook signature');
    }
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw body not available for signature verification');
    }

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(signature, 'hex');
    const signatureValid =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!signatureValid) {
      throw new BadRequestException('Invalid webhook signature');
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed webhook payload');
    }

    if (event?.event !== 'payment.captured') {
      // Acknowledge everything else so Razorpay stops retrying - we only act on captures.
      return { received: true, ignored: event?.event ?? 'unknown' };
    }

    const payment = event.payload?.payment?.entity;
    const razorpayOrderId = payment?.order_id;
    const razorpayPaymentId = payment?.id;
    if (!razorpayOrderId || !razorpayPaymentId) {
      throw new BadRequestException('Malformed payment.captured payload');
    }

    const order = await this.prisma.order.findUnique({ where: { razorpayOrderId } });
    if (!order) {
      // Nothing to reconcile against - acknowledge so Razorpay doesn't retry forever.
      return { received: true, matched: false };
    }

    if (order.status !== OrderStatus.PENDING) {
      // Already handled - either by /verify already, or a prior webhook delivery.
      return { received: true, alreadyProcessed: true };
    }

    await this.markAsPaid(order.id, razorpayPaymentId, razorpayPaymentId);
    return { received: true, matched: true };
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

  async findAllAdmin(page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        include: {
          user: { select: { email: true, firstName: true } },
          deliveryBoy: { select: { id: true, email: true, firstName: true, lastName: true } },
          items: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count(),
    ]);

    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
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