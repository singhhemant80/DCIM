import { createApp } from './bootstrap';
import { loadConfig } from './config/config';
import { createLogger } from './common/logger';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));

  const app = await createApp(config, logger);
  await app.listen(config.PORT, config.HOST);
  logger.info({ host: config.HOST, port: config.PORT, swagger: config.ENABLE_SWAGGER }, 'NexoraDC API listening');
}

main().catch((err) => {
  process.stderr.write(`Fatal startup error: ${(err as Error).message}\n`);
  process.exit(1);
});
