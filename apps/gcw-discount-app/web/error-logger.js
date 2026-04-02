export const ERROR_LOG_MAX = 200;
export const errorLog = [];

export function reportError(error, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    area: context.area || 'unknown',
    message: error?.message || String(error),
    stack: (error?.stack || '').split('\n').slice(0, 6).join('\n'),
    ...context,
  };
  errorLog.unshift(entry);
  if (errorLog.length > ERROR_LOG_MAX) errorLog.length = ERROR_LOG_MAX;
  console.error(`[GCW Error][${entry.area}]`, entry.message);
}
