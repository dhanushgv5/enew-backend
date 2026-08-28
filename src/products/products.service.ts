import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, QueryProductsDto } from './dto/product.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateProductDto) {
    try {
      return await this.prisma.product.create({
        data: {
          ...dto,
          price: new Prisma.Decimal(dto.price),
          compareAtPrice: dto.compareAtPrice
            ? new Prisma.Decimal(dto.compareAtPrice)
            : null,
          images: dto.images || [],
        },
        include: { category: true },
      });
       } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('SKU or slug already exists');
      }
      throw e;
    }
  }

  async findAll(query: QueryProductsDto) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 12, 50);
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      ...(query.categoryId && { categoryId: query.categoryId }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: { select: { id: true, name: true, slug: true } } },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(idOrSlug: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
        isActive: true,
      },
      include: {
        category: true,
        reviews: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    try {
      return await this.prisma.product.update({
        where: { id },
        data: {
          ...dto,
          ...(dto.price !== undefined && { price: new Prisma.Decimal(dto.price) }),
          ...(dto.compareAtPrice !== undefined && {
            compareAtPrice: new Prisma.Decimal(dto.compareAtPrice),
          }),
        },
        include: { category: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('SKU or slug already exists');
      }
      throw e;
    }
  }

  async remove(id: string) {
    await this.findOne(id);
    // Soft delete
    return this.prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // Note: stock reservation/release/confirmation is handled inline inside the
  // relevant Prisma $transaction in OrdersService (createFromCart, markAsPaid,
  // updateStatus) rather than here, since each needs to run as part of a larger
  // atomic transaction alongside the order write.
}