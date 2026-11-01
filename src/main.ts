import 'dotenv/config';
import { createApp } from './app';
import { assertConfig, port, serverRoot } from './config';
import { disconnectDb } from './db';

assertConfig();

const app = createApp();
const listenPort = port();

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
