import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth, getSupabaseClients, getUserId } from '../middleware/auth.js';

export async function statsRoutes(app: FastifyInstance) {
  // All stats routes require auth
  app.addHook('preHandler', requireAuth);

  // Stats for a pocket - shows document and chunk counts
  app.get<{ Params: { pocketId: string } }>('/:pocketId', async (request, reply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { pocketId } = request.params;

    // Verify pocket access
    const { data: pocketMember, error: memberError } = await user
      .from('pocket_members')
      .select('org_id')
      .eq('pocket_id', pocketId)
      .eq('user_id', userId)
      .single();

    if (memberError || !pocketMember) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You do not have access to this pocket',
      });
    }

    // Get document (source) count
    const { count: sourceCount, error: sourceError } = await service
      .from('sources')
      .select('*', { count: 'exact', head: true })
      .eq('pocket_id', pocketId)
      .eq('status', 'ready');

    if (sourceError) {
      app.log.error(sourceError);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to get source count',
      });
    }

    // Get chunk count
    const { count: chunkCount, error: chunkError } = await service
      .from('chunks')
      .select('*', { count: 'exact', head: true })
      .eq('pocket_id', pocketId);

    if (chunkError) {
      app.log.error(chunkError);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to get chunk count',
      });
    }

    return {
      data: {
        pocket_id: pocketId,
        documents: sourceCount || 0,
        chunks: chunkCount || 0,
      },
    };
  });
}
