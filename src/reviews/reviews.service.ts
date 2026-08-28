import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReviewDto, QueryReviewsDto, UpdateReviewDto } from './dto/review.dto';

const PUBLIC_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  private async assertProductExists(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
  }

  // A review is flagged "verified" when the reviewer has a delivered order
  // containing the product - informational only, never blocks reviewing.
  private async isVerifiedPurchase(userId: string, productId: string) {
    const count = await this.prisma.orderItem.count({
      where: {
        productId,
        order: { userId, status: OrderStatus.DELIVERED },
      },
    });
    return count > 0;
  }

  async create(userId: string, dto: CreateReviewDto) {
    await this.assertProductExists(dto.productId);

    try {
      const review = await this.prisma.review.create({
        data: {
          userId,
          productId: dto.productId,
          rating: dto.rating,
          title: dto.title,
          comment: dto.comment,
          photos: dto.photos || [],
        },
        include: { user: { select: PUBLIC_USER_SELECT } },
      });
      return {
        ...review,
        verifiedPurchase: await this.isVerifiedPurchase(userId, dto.productId),
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'You have already reviewed this product. Edit your existing review instead.',
        );
      }
      throw e;
    }
  }

  async findByProduct(productId: string, query: QueryReviewsDto) {
    await this.assertProductExists(productId);

    const page = query.page || 1;
    const limit = Math.min(query.limit || 10, 50);
    const skip = (page - 1) * limit;

    const [items, total, summary] = await Promise.all([
      this.prisma.review.findMany({
        where: { productId },
        include: { user: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.review.count({ where: { productId } }),
      this.getSummary(productId),
    ]);

    return {
      items,
      summary,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getSummary(productId: string) {
    const [aggregate, breakdown] = await Promise.all([
      this.prisma.review.aggregate({
        where: { productId },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where: { productId },
        _count: { _all: true },
      }),
    ]);

    const distribution: Record<1 | 2 | 3 | 4 | 5, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    for (const row of breakdown) {
      distribution[row.rating as 1 | 2 | 3 | 4 | 5] = row._count._all;
    }

    return {
      average: aggregate._avg.rating ? Number(aggregate._avg.rating.toFixed(2)) : 0,
      total: aggregate._count._all,
      distribution,
    };
  }

  // Admin view - across all products, optionally filtered to one product.
  async findAllAdmin(query: QueryReviewsDto) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.ReviewWhereInput = {
      ...(query.productId && { productId: query.productId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: {
          user: { select: PUBLIC_USER_SELECT },
          product: { select: { id: true, name: true, slug: true, images: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.review.count({ where }),
    ]);

    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findMine(userId: string, productId: string) {
    return this.prisma.review.findUnique({
      where: { userId_productId: { userId, productId } },
    });
  }

  private async findOwnedOrThrow(id: string, userId: string, role: Role) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw new NotFoundException('Review not found');

    const isOwner = review.userId === userId;
    const isAdmin = role === Role.ADMIN || role === Role.SUPER_ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You can only manage your own reviews');
    }
    return review;
  }

  async update(id: string, userId: string, role: Role, dto: UpdateReviewDto) {
    const review = await this.findOwnedOrThrow(id, userId, role);
    // Only the author can edit content (admins can moderate via delete only).
    if (review.userId !== userId) {
      throw new ForbiddenException('Only the review author can edit it');
    }
    return this.prisma.review.update({
      where: { id },
      data: {
        ...(dto.rating !== undefined && { rating: dto.rating }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.comment !== undefined && { comment: dto.comment }),
        ...(dto.photos !== undefined && { photos: dto.photos }),
      },
      include: { user: { select: PUBLIC_USER_SELECT } },
    });
  }

  async remove(id: string, userId: string, role: Role) {
    await this.findOwnedOrThrow(id, userId, role);
    await this.prisma.review.delete({ where: { id } });
    return { success: true };
  }
}
