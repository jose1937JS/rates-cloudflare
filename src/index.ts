import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { healthRoutes } from './routes/health';
import { ratesRoutes } from './routes/rates';
import { syncRoutes } from './routes/sync';
import { syncService } from './services/sync.service';
import type { Env } from './types/env';

export const app = new Hono<{ Bindings: Env }>();

app.use('*', securityHeadersMiddleware);
app.use('*', corsMiddleware);
app.use('*', rateLimitMiddleware);
app.use('/api/*', authMiddleware);

app.route('/health', healthRoutes);
app.route('/api/rates', ratesRoutes);
app.route('/api/sync', syncRoutes);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        if (event.cron === '0 10 * * 1-5') {
          await syncService.sync(env, 'bcv');
        } else if (event.cron === '0 */4 * * *') {
          await syncService.sync(env, 'yadio');
        } else {
          await syncService.sync(env, 'all');
        }
      })()
    );
  },
};
