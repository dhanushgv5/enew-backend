import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminHash = await bcrypt.hash('Admin123!', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      passwordHash: adminHash,
      firstName: 'Super',
      lastName: 'Admin',
      role: Role.SUPER_ADMIN,
    },
  });

  // Create customer
  const customerHash = await bcrypt.hash('Customer123!', 12);
  const customer = await prisma.user.upsert({
    where: { email: 'customer@example.com' },
    update: {},
    create: {
      email: 'customer@example.com',
      passwordHash: customerHash,
      firstName: 'John',
      lastName: 'Doe',
      role: Role.CUSTOMER,
    },
  });

  // Create cart for customer
  await prisma.cart.upsert({
    where: { userId: customer.id },
    update: {},
    create: { userId: customer.id },
  });

  // Categories
  const electronics = await prisma.category.upsert({
    where: { slug: 'electronics' },
    update: {},
    create: {
      name: 'Electronics',
      slug: 'electronics',
      description: 'Latest gadgets and electronics',
    },
  });

  const clothing = await prisma.category.upsert({
    where: { slug: 'clothing' },
    update: {},
    create: {
      name: 'Clothing',
      slug: 'clothing',
      description: 'Fashion and apparel',
    },
  });

  // Products
  const products = [
    {
      name: 'Wireless Headphones Pro',
      slug: 'wireless-headphones-pro',
      description: 'Premium noise-cancelling wireless headphones with 30h battery.',
      price: 199.99,
      compareAtPrice: 249.99,
      sku: 'WHP-001',
      stock: 50,
      images: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500'],
      categoryId: electronics.id,
    },
    {
      name: 'Smart Watch Ultra',
      slug: 'smart-watch-ultra',
      description: 'Advanced fitness tracking and notifications.',
      price: 349.99,
      sku: 'SWU-001',
      stock: 30,
      images: ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500'],
      categoryId: electronics.id,
    },
    {
      name: 'Classic Cotton T-Shirt',
      slug: 'classic-cotton-tshirt',
      description: 'Soft premium cotton t-shirt, available in multiple colors.',
      price: 29.99,
      compareAtPrice: 39.99,
      sku: 'CTS-001',
      stock: 200,
      images: ['https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=500'],
      categoryId: clothing.id,
    },
    {
      name: 'Running Shoes Elite',
      slug: 'running-shoes-elite',
      description: 'Lightweight running shoes with superior cushioning.',
      price: 129.99,
      sku: 'RSE-001',
      stock: 75,
      images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500'],
      categoryId: clothing.id,
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: p,
    });
  }

  console.log('✅ Seed completed');
  console.log('Admin: admin@example.com / Admin123!');
  console.log('Customer: customer@example.com / Customer123!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
