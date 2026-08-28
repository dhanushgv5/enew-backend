# E-Commerce Backend (NestJS + Prisma + PostgreSQL)

Production-oriented NestJS backend with:

- **JWT Access + Refresh Token** (HttpOnly cookie for refresh, rotation + reuse detection)
- **RBAC** (SUPER_ADMIN, ADMIN, SELLER, CUSTOMER) via Guards + Decorators
- **Solid inventory logic** (reservedStock + transactions to prevent overselling)
- **Order state machine** with valid transitions
- **Real-time** via Socket.io (stock updates, order notifications)
- **PostgreSQL** + Prisma
- Helmet, rate limiting, validation, global exception filter

## Quick Start

### 1. Start PostgreSQL

```bash
docker compose up -d
```

### 2. Environment

```bash
cp .env.example .env
# Edit if needed
```

### 3. Install & Migrate

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run prisma:seed
```

### 4. Run

```bash
npm run start:dev
```

API: http://localhost:4000/api

## Main Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /auth/register | Public | Register |
| POST | /auth/login | Public | Login (sets refresh cookie) |
| POST | /auth/refresh | Cookie | Refresh access token |
| POST | /auth/logout | JWT | Logout |
| GET | /users/me | JWT | Current user |
| GET | /products | Public | List products |
| GET | /products/:idOrSlug | Public | Product detail |
| POST | /products | Admin/Seller | Create product |
| GET | /cart | JWT | Get cart |
| POST | /cart/items | JWT | Add to cart |
| POST | /orders | JWT | Create order from cart |
| GET | /orders | JWT | My orders |
| PATCH | /orders/:id/status | Admin/Customer | Update status |
| POST | /orders/:id/pay | Admin | Simulate payment |

## Test Accounts (after seed)

- Admin: `admin@example.com` / `Admin123!`
- Customer: `customer@example.com` / `Customer123!`

## Security Notes

- Change JWT secrets in production
- Use HTTPS
- Refresh tokens are hashed in DB
- Token rotation on every refresh
- Stock is reserved on order creation and confirmed on payment
