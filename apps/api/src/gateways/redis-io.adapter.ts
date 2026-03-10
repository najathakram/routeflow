import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private readonly connectPromise: Promise<void>;

  constructor(app: INestApplication) {
    super(app);
    const config = app.get(ConfigService);
    const rawUrl = config.get<string>('redis.url') ?? 'redis://localhost:6379';
    const password = config.get<string>('redis.password');

    const options = password ? { password } : {};

    const pubClient = createClient({ url: rawUrl, ...options });
    const subClient = pubClient.duplicate();

    // Surface Redis errors via logger so they're not silently swallowed
    pubClient.on('error', (err) => this.logger.error('Redis pub client error', err));
    subClient.on('error', (err) => this.logger.error('Redis sub client error', err));

    this.connectPromise = Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        this.adapterConstructor = createAdapter(pubClient, subClient);
        this.logger.log('Redis adapter connected');
      })
      .catch((err) => {
        this.logger.error(
          'Redis adapter connection failed — falling back to in-memory adapter',
          err,
        );
        // Leave adapterConstructor null so createIOServer uses the default in-memory adapter
      });
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
