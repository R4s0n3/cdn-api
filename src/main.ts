import 'dotenv/config';

import { createApp } from './app';
import { getConfig } from './config';
import { db } from './db';
import { destroyObjectStorage } from './storage/s3-storage';

const config = getConfig();
const app = createApp(config);
const server = app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    console.error('Server failed to start', error);
    process.exitCode = 1;
    return;
  }

  console.log(`Server is listening on http://${config.host}:${config.port}`);
});

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  const forceShutdownTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    server.closeAllConnections();
    process.exit(1);
  }, 10000);
  forceShutdownTimer.unref();

  server.close(async (error) => {
    let exitCode = error ? 1 : 0;

    try {
      if (error) {
        console.error('Server shutdown failed', error);
      }

      await db.$disconnect();
    } catch (disconnectError) {
      exitCode = 1;
      console.error('Database shutdown failed', disconnectError);
    } finally {
      destroyObjectStorage();
      clearTimeout(forceShutdownTimer);
      process.exit(exitCode);
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
