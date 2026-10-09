import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from './config/config';
import { DB, PG_POOL, createDb, createPool } from './db/db';
import { REDIS, createRedis } from './redis/redis';
import { LOGGER } from './common/logger';
import { SecretBox } from './common/secret-box';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard, PermissionsGuard } from './auth/guards';
import { MfaService } from './auth/mfa.service';
import { PasswordService } from './auth/password.service';
import { SessionService } from './auth/session.service';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { HealthController } from './health/health.controller';
import { OverviewController } from './overview/overview.controller';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { SettingsController } from './settings/settings.controller';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Injectable()
class ResourceCloser implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.pool.end();
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Default budget per client IP; auth routes override with tighter limits.
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
      ],
      controllers: [
        AuthController,
        UsersController,
        RolesController,
        CustomersController,
        SettingsController,
        AuditController,
        HealthController,
        OverviewController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: PG_POOL, useFactory: () => createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX) },
        { provide: DB, useFactory: (pool: Pool) => createDb(pool), inject: [PG_POOL] },
        { provide: REDIS, useFactory: () => createRedis(config.REDIS_URL) },
        { provide: SecretBox, useFactory: () => new SecretBox(config.CDCIM_ENCRYPTION_KEYS) },
        ResourceCloser,
        AuditService,
        PasswordService,
        SessionService,
        MfaService,
        AuthService,
        RolesService,
        UsersService,
        CustomersService,
        // Order matters: rate limit → authenticate → authorize.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useFactory: () => new AllExceptionsFilter(logger) },
      ],
    };
  }
}
