import 'dotenv/config';
import { createApp } from './app';
import { assertConfig, getConfig, port, serverRoot } from './config';
import { disconnectDb } from './db';
import { sweepStaleUploads } from './util/upload-staging';

assertConfig();

const app = createApp(process.env.S3_ENDPOINT ? getConfig() : undefined);
const listenPort = port();

async function start(): Promise<void> {
  await sweepStaleUploads();
  const server = app.listen(listenPort, '0.0.0.0', () => {
    console.log(`CDN listening on port ${listenPort}`);
    console.log(`Storage root ${serverRoot()}`);
  });

  function shutdown(signal: string) {
    console.log(`Received ${signal}, closing server`);
    server.close(() => {
      disconnectDb().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void start().catch((error: unknown) => {
  console.error('CDN startup failed', error);
  process.exitCode = 1;
});
