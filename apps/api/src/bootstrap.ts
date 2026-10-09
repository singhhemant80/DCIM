import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config';
import { PinoNestLogger } from './common/logger';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Builds the HTTP application. Shared by `main.ts` and the e2e tests so both run identical middleware. */
export async function createApp(config: AppConfig, logger: Logger): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, logger), {
    logger: new PinoNestLogger(logger),
    bodyParser: false,
  });

  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  app.use(
    helmet({
      // Serves the API (JSON), Swagger UI and, optionally, the built web app.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          // Forcing https:// sub-requests is only correct when the site is served over HTTPS.
          // On a plain-HTTP lab install it makes every asset fail with an SSL error (blank page).
          upgradeInsecureRequests: config.COOKIE_SECURE ? [] : null,
        },
      },
      hsts: config.NODE_ENV === 'production' && config.COOKIE_SECURE,
      // These only take effect on secure origins; on plain HTTP they just produce console noise.
      crossOriginOpenerPolicy: config.COOKIE_SECURE,
      originAgentCluster: config.COOKIE_SECURE,
    }),
  );
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.enableCors({
    origin: config.WEB_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });
  if (config.WEB_DIST_DIR) serveWebApp(app as NestExpressApplication, config.WEB_DIST_DIR);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableShutdownHooks();

  if (config.ENABLE_SWAGGER) {
    const doc = new DocumentBuilder()
      .setTitle('Crapplet DCIM API')
      .setDescription(
        'Versioned REST API. Authenticate via POST /api/v1/auth/login (session cookie). ' +
          'State-changing requests must send the X-CSRF-Token header with the value of the cdcim_csrf cookie.',
      )
      .setVersion('1.0')
      .addCookieAuth('cdcim_session')
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
  return app;
}

/**
 * Serves the built SPA from the API process: hashed assets are cached for a
 * year, everything else that isn't /api falls back to index.html (client-side
 * routing). Registered before Nest's routes; /api requests pass straight through.
 */
function serveWebApp(app: NestExpressApplication, dir: string): void {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);
  app.use('/assets', express.static(path.join(root, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }));
  app.use(express.static(root, { index: false, maxAge: '1h' }));
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
