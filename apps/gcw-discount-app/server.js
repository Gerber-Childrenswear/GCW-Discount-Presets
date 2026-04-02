/**
 * server.js — Application entrypoint.
 * Delegates to web/index.js which contains the full Express server.
 *
 * Usage:
 *   node server.js        (production — starts web/index.js)
 *   npm run server:dev     (development — nodemon watches for changes)
 */
import('./web/index.js').catch((err) => {
  console.error('[server.js] Failed to start application:', err.message);
  process.exit(1);
});

