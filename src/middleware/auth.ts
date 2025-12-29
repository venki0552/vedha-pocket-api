import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Middleware to require authentication
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!(request as any).userId) {
    return reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
}

// Helper to get user ID from request
export function getUserId(request: FastifyRequest): string {
  const userId = (request as any).userId;
  if (!userId) {
    throw new Error('User ID not available - ensure requireAuth middleware is used');
  }
  return userId;
}

// Helper to get Supabase clients from request
export function getSupabaseClients(request: FastifyRequest) {
  return {
    service: (request as any).supabaseService,
    user: (request as any).supabaseUser,
  };
}

// Register auth middleware as preHandler
export function registerAuthHook(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
}
