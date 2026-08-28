import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { ProductsModule } from '../products/products.module';
import { CartModule } from '../cart/cart.module';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [ProductsModule, CartModule, WebsocketModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}