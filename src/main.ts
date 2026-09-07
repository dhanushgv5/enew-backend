import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';          // ← fixed
import express from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Security
  // helmet's default cross-origin-resource-policy blocks the frontend (a
  // different origin) from loading review photos served below, so relax it.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());

  // Serve uploaded review photos (e.g. /uploads/reviews/xyz.jpg)
  app.use('/uploads', express.static(join(process.cwd(), 'uploads')));
  app.enableCors({
    origin: configService.get('FRONTEND_URL') || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  app.setGlobalPrefix('api');

  const port = configService.get('PORT') || 4000;
  // Railway's proxy needs the app bound to all interfaces (0.0.0.0), not
  // just localhost -- without this, the container shows "Running" but the
  // proxy can never actually reach the process, producing a 502 on every
  // request even though nothing is wrong with the app itself.
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 Server running on http://localhost:${port}/api`);
}
bootstrap();