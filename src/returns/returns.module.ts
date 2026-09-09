import { Module } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { WebsocketModule } from '../websocket/websocket.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [WebsocketModule, OrdersModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
