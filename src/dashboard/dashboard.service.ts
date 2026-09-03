import { Injectable } from '@nestjs/common';
import { OrderStatus, ReturnStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Revenue only counts orders that actually collected payment - a PENDING
// (unpaid) or CANCELLED order was never real revenue.
const REVENUE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

const LOW_STOCK_THRESHOLD = 5;

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfWeek(d = new Date()) {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function startOfMonth(d = new Date()) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getOverview() {
    const [
      revenueToday,
      revenueWeek,
      revenueMonth,
      revenueAllTime,
      orderCountsByStatus,
      totalProducts,
      lowStockCount,
      lowStockProducts,
      outOfStockCount,
      pendingReturns,
      reviewAggregate,
      recentOrders,
      recentReviews,
      totalCustomers,
    ] = await Promise.all([
      this.sumRevenueSince(startOfDay()),
      this.sumRevenueSince(startOfWeek()),
      this.sumRevenueSince(startOfMonth()),
      this.sumRevenueSince(null),

      this.prisma.order.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),

      this.prisma.product.count({ where: { isActive: true } }),

      this.prisma.product.count({
        where: { isActive: true, stock: { lte: LOW_STOCK_THRESHOLD, gt: 0 } },
      }),

      this.prisma.product.findMany({
        where: { isActive: true, stock: { lte: LOW_STOCK_THRESHOLD, gt: 0 } },
        select: { id: true, name: true, slug: true, stock: true, images: true },
        orderBy: { stock: 'asc' },
        take: 5,
      }),

      this.prisma.product.count({ where: { isActive: true, stock: 0 } }),

      this.prisma.returnRequest.count({ where: { status: ReturnStatus.REQUESTED } }),

      this.prisma.review.aggregate({
        _avg: { rating: true },
        _count: { _all: true },
      }),

      this.prisma.order.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          createdAt: true,
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      }),

      this.prisma.review.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          rating: true,
          title: true,
          createdAt: true,
          product: { select: { id: true, name: true, slug: true } },
          user: { select: { firstName: true, lastName: true } },
        },
      }),

      this.prisma.user.count({ where: { role: 'CUSTOMER' } }),
    ]);

    const orderStatusMap: Record<string, number> = {};
    for (const row of orderCountsByStatus) {
      orderStatusMap[row.status] = row._count._all;
    }
    const totalOrders = Object.values(orderStatusMap).reduce((sum, n) => sum + n, 0);

    return {
      revenue: {
        today: revenueToday,
        thisWeek: revenueWeek,
        thisMonth: revenueMonth,
        allTime: revenueAllTime,
      },
      orders: {
        total: totalOrders,
        byStatus: orderStatusMap,
      },
      products: {
        total: totalProducts,
        lowStockCount,
        outOfStock: outOfStockCount,
      },
      lowStockProducts,
      returns: {
        pending: pendingReturns,
      },
      reviews: {
        total: reviewAggregate._count._all,
        average: reviewAggregate._avg.rating
          ? Number(reviewAggregate._avg.rating.toFixed(2))
          : 0,
      },
      customers: {
        total: totalCustomers,
      },
      recentOrders,
      recentReviews,
    };
  }

  private async sumRevenueSince(since: Date | null) {
    const result = await this.prisma.order.aggregate({
      where: {
        status: { in: REVENUE_STATUSES },
        ...(since && { createdAt: { gte: since } }),
      },
      _sum: { total: true },
    });
    return Number(result._sum.total || 0);
  }
}
