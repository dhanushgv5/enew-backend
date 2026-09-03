import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PRODUCT_CARD_INCLUDE = {
  product: {
    include: { category: { select: { id: true, name: true, slug: true } } },
  },
} satisfies Prisma.WishlistItemInclude;

@Injectable()
export class WishlistService {
  constructor(private prisma: PrismaService) {}

  async findMine(userId: string) {
    return this.prisma.wishlistItem.findMany({
      where: { userId },
      include: PRODUCT_CARD_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  // Returns just the set of product IDs the user has wishlisted - cheap to
  // fetch alongside a product listing so ProductCard can show a filled/empty
  // heart without an extra round trip per card.
  async findMyProductIds(userId: string) {
    const items = await this.prisma.wishlistItem.findMany({
      where: { userId },
      select: { productId: true },
    });
    return items.map((i: { productId: string }) => i.productId);
  }

  async add(userId: string, productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    try {
      return await this.prisma.wishlistItem.create({
        data: { userId, productId },
        include: PRODUCT_CARD_INCLUDE,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Already in your wishlist');
      }
      throw e;
    }
  }

  async remove(userId: string, productId: string) {
    const deleted = await this.prisma.wishlistItem.deleteMany({ where: { userId, productId } });
    if (deleted.count === 0) throw new NotFoundException('Item not in wishlist');
    return { success: true };
  }
}
