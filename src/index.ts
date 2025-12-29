import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import * as Sentry from '@sentry/node';
import { createServiceClient, createUserClient } from '@vedha/db';
import { env } from './config/env.js';

// Import routes
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { pocketRoutes } from './routes/pockets.js';
import { sourceRoutes } from './routes/sources.js';
import { searchRoutes } from './routes/search.js';
import { askRoutes } from './routes/ask.js';
import { askStreamRoutes } from './routes/ask-stream.js';
import { statsRoutes } from './routes/stats.js';
import { taskRoutes } from './routes/tasks.js';
import { analyticsRoutes } from './routes/analytics.js';
import { settingsRoutes } from './routes/settings.js';

// Initialize Sentry
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.1,
  });
}

// Create Fastify instance
const app: FastifyInstance = Fastify({
  logger: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: env.NODE_ENV === 'development' ? {
      target: 'pino-pretty',
      options: { colorize: true },
    } : undefined,
  },
});

// Register plugins
await app.register(cors, {
  origin: env.NODE_ENV === 'production' 
    ? [/\.vercel\.app$/, /localhost/] 
    : true,
  credentials: true,
});

await app.register(helmet, {
  contentSecurityPolicy: false, // Disable for API
});

// Rate limiting
if (env.RATE_LIMIT_ENABLED) {
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis: undefined, // Will use in-memory for now, Redis can be added
  });
}

// Decorate request with Supabase clients
app.decorateRequest('supabaseService', null);
app.decorateRequest('supabaseUser', null);
app.decorateRequest('userId', null);

// Auth hook for protected routes
app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
  // Always add service client
  const serviceClient = createServiceClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY
  );
  (request as any).supabaseService = serviceClient;

  // Skip auth for health check
  if (request.url === '/health') return;

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // No auth header - some routes may allow this
    return;
  }

  const token = authHeader.slice(7);
  
  // Verify token using service client (more reliable)
  const { data: { user }, error } = await serviceClient.auth.getUser(token);
  
  if (error || !user) {
    app.log.warn({ error: error?.message }, 'Token verification failed');
    return;
  }

  // Create user client with verified token for RLS
  const userClient = createUserClient(
    env.SUPABASE_URL,
    env.SUPABASE_ANON_KEY,
    token
  );

  (request as any).supabaseUser = userClient;
  (request as any).userId = user.id;
});

// Error handler
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  
  if (env.SENTRY_DSN) {
    Sentry.captureException(error);
  }

  // Zod validation errors
  if (error.name === 'ZodError') {
    return reply.status(400).send({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: error,
    });
  }

  // Rate limit errors
  if (error.statusCode === 429) {
    return reply.status(429).send({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later',
    });
  }

  // Default error response
  return reply.status(error.statusCode || 500).send({
    code: 'INTERNAL_ERROR',
    message: env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred' 
      : error.message,
  });
});

// Register routes
await app.register(healthRoutes);
await app.register(authRoutes, { prefix: '/auth' });
await app.register(orgRoutes, { prefix: '/orgs' });
await app.register(pocketRoutes, { prefix: '/pockets' });
await app.register(sourceRoutes, { prefix: '/sources' });
await app.register(searchRoutes, { prefix: '/search' });
await app.register(askRoutes, { prefix: '/ask' });
await app.register(askStreamRoutes, { prefix: '/ask' });
await app.register(statsRoutes, { prefix: '/stats' });
await app.register(taskRoutes, { prefix: '/tasks' });
await app.register(analyticsRoutes, { prefix: '/analytics' });
await app.register(settingsRoutes, { prefix: '/settings' });

// Start server
const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 API server running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

export { app };
