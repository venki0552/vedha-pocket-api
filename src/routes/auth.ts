import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSupabaseClients } from '../middleware/auth.js';

export async function authRoutes(app: FastifyInstance) {
  // Get current user info
  app.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    
    if (!user) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    const { data: { user: authUser }, error } = await user.auth.getUser();
    
    if (error || !authUser) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Invalid session',
      });
    }

    return {
      id: authUser.id,
      email: authUser.email,
      created_at: authUser.created_at,
    };
  });

  // Note: Actual signup/login is handled by Supabase Auth on the frontend
  // This route just provides user info for authenticated users
}
