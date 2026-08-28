import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/realtime',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private userSockets = new Map<string, string>(); // userId -> socketId

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.split(' ')[1];

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get('JWT_ACCESS_SECRET') || 'access-secret-change-me',
      });

      client.data.userId = payload.sub;
      client.data.role = payload.role;
      this.userSockets.set(payload.sub, client.id);

      client.join(`user:${payload.sub}`);
      if (['ADMIN', 'SUPER_ADMIN'].includes(payload.role)) {
        client.join('admin');
      }

      this.logger.log(`Client connected: ${client.id} (user: ${payload.sub})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data.userId) {
      this.userSockets.delete(client.data.userId);
    }
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // Emit stock update to everyone watching a product
  emitStockUpdate(productId: string, stock: number, reserved: number) {
    this.server.emit('stock:update', {
      productId,
      available: stock - reserved,
      stock,
      reserved,
    });
  }

  // Notify user about order status
  emitOrderUpdate(userId: string, order: any) {
    this.server.to(`user:${userId}`).emit('order:update', order);
    this.server.to('admin').emit('order:new', order);
  }

  // Notify user + admins about a return/replacement request change
  emitReturnUpdate(userId: string, returnRequest: any) {
    this.server.to(`user:${userId}`).emit('return:update', returnRequest);
    this.server.to('admin').emit('return:update', returnRequest);
  }

  @SubscribeMessage('join:product')
  handleJoinProduct(
    @ConnectedSocket() client: Socket,
    @MessageBody() productId: string,
  ) {
    client.join(`product:${productId}`);
    return { event: 'joined', productId };
  }
}
