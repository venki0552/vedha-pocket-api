import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { searchSchema, VECTOR_WEIGHT, FTS_WEIGHT, SEARCH_RESULT_LIMIT } from '@vedha/shared';
import { OpenRouterEmbeddingProvider } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { env } from '../config/env.js';

export async function searchRoutes(app: FastifyInstance) {
  // All search routes require auth
  app.addHook('preHandler', requireAuth);

  // Hybrid search
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = searchSchema.parse(request.body);

    // Verify pocket access
    const { data: pocketMember, error: memberError } = await user
      .from('pocket_members')
      .select('org_id')
      .eq('pocket_id', body.pocket_id)
      .eq('user_id', userId)
      .single();

    if (memberError || !pocketMember) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You do not have access to this pocket',
      });
    }

    try {
      // Get query embedding
      const embeddingProvider = new OpenRouterEmbeddingProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        embedModel: env.OPENROUTER_EMBED_MODEL,
      });

      const [queryEmbedding] = await embeddingProvider.embed([body.query]);

      // Call hybrid search function
      const { data: results, error } = await service.rpc('hybrid_search', {
        query_embedding: `[${queryEmbedding.join(',')}]`,
        query_text: body.query,
        target_pocket_id: body.pocket_id,
        match_count: body.limit || SEARCH_RESULT_LIMIT,
        vector_weight: VECTOR_WEIGHT,
        fts_weight: FTS_WEIGHT,
      });

      if (error) {
        app.log.error(error);
        return reply.status(500).send({
          code: 'SEARCH_ERROR',
          message: 'Failed to perform search',
        });
      }

      // Log audit event
      await service.from('audit_events').insert({
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        user_id: userId,
        event_type: 'search',
        metadata: { query: body.query, result_count: results?.length || 0 },
      });

      return {
        data: results?.map((r: any) => ({
          chunk_id: r.chunk_id,
          source_id: r.source_id,
          source_title: r.source_title,
          source_type: r.source_type,
          page: r.page,
          text: r.text,
          score: r.combined_score,
        })) || [],
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'EMBEDDING_ERROR',
        message: 'Failed to generate search embedding',
      });
    }
  });
}
