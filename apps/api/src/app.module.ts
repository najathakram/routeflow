import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';

import { configuration } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CustomersModule } from './customers/customers.module';
import { DriversModule } from './drivers/drivers.module';
import { ProductsModule } from './products/products.module';
import { RoutesModule } from './routes/routes.module';
import { OrdersModule } from './orders/orders.module';
import { BookkeepingModule } from './bookkeeping/bookkeeping.module';
import { ZohoSyncModule } from './zoho-sync/zoho-sync.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RouteOptimizationModule } from './route-optimization/route-optimization.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    // ─── Config (global) ──────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // ─── Prisma (global) ──────────────────────────────────────────────────────
    PrismaModule,

    // ─── Rate limiting (100 req / 60 s per IP) ────────────────────────────────
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    // ─── Redis queue ──────────────────────────────────────────────────────────
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const rawUrl = config.get<string>('redis.url') ?? 'redis://localhost:6379';
        let redisUrl: URL;
        try {
          redisUrl = new URL(rawUrl);
        } catch {
          redisUrl = new URL('redis://localhost:6379');
        }
        const password = config.get<string>('redis.password');
        return {
          redis: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            ...(password ? { password } : {}),
          },
        };
      },
    }),

    // ─── Cron scheduler ───────────────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ─── Feature modules ──────────────────────────────────────────────────────
    AuthModule,
    UsersModule,
    CustomersModule,
    DriversModule,
    ProductsModule,
    RoutesModule,
    OrdersModule,
    BookkeepingModule,
    ZohoSyncModule,
    NotificationsModule,
    RouteOptimizationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
