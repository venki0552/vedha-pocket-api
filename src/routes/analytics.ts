import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { estimateTokens } from '@vedha/shared';
import { requireAuth, getSupabaseClients } from '../middleware/auth.js';

export async function analyticsRoutes(app: FastifyInstance) {
  // All analytics routes require auth
  app.addHook('preHandler', requireAuth);

  // Get analytics for a pocket or org
  app.get('/', async (request: FastifyRequest<{ Querystring: { pocket_id?: string; org_id?: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { pocket_id, org_id } = request.query;

    if (!pocket_id && !org_id) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Either pocket_id or org_id is required',
      });
    }

    try {
      // Get source counts by type and status
      let sourceQuery = user
        .from('sources')
        .select('type, status, size_bytes');

      if (pocket_id) {
        sourceQuery = sourceQuery.eq('pocket_id', pocket_id);
      } else if (org_id) {
        sourceQuery = sourceQuery.eq('org_id', org_id);
      }

      const { data: sources, error: sourceError } = await sourceQuery;

      if (sourceError) {
        app.log.error(sourceError);
        return reply.status(500).send({
          code: 'DATABASE_ERROR',
          message: 'Failed to fetch source analytics',
        });
      }

      // Get chunk count and text for token estimation
      let chunkQuery = user
        .from('chunks')
        .select('id, text');

      if (pocket_id) {
        chunkQuery = chunkQuery.eq('pocket_id', pocket_id);
      } else if (org_id) {
        chunkQuery = chunkQuery.eq('org_id', org_id);
      }

      // Limit to avoid huge response
      const { data: chunks, count: chunkCount, error: chunkError } = await chunkQuery
        .select('id, text', { count: 'exact' })
        .limit(1000);

      if (chunkError) {
        app.log.error(chunkError);
        return reply.status(500).send({
          code: 'DATABASE_ERROR',
          message: 'Failed to fetch chunk analytics',
        });
      }

      // Calculate analytics
      const sourcesByType: Record<string, number> = {};
      const sourcesByStatus: Record<string, number> = {};
      let totalStorageBytes = 0;

      for (const source of sources || []) {
        sourcesByType[source.type] = (sourcesByType[source.type] || 0) + 1;
        sourcesByStatus[source.status] = (sourcesByStatus[source.status] || 0) + 1;
        totalStorageBytes += source.size_bytes || 0;
      }

      // Estimate tokens from chunks
      let estimatedEmbeddingTokens = 0;
      for (const chunk of chunks || []) {
        estimatedEmbeddingTokens += estimateTokens(chunk.text);
      }

      // If we hit the limit, extrapolate
      if ((chunkCount || 0) > 1000 && chunks) {
        const avgTokensPerChunk = estimatedEmbeddingTokens / chunks.length;
        estimatedEmbeddingTokens = Math.round(avgTokensPerChunk * (chunkCount || 0));
      }

      return {
        data: {
          total_sources: sources?.length || 0,
          total_chunks: chunkCount || 0,
          total_storage_bytes: totalStorageBytes,
          estimated_embedding_tokens: estimatedEmbeddingTokens,
          sources_by_type: sourcesByType,
          sources_by_status: sourcesByStatus,
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'ANALYTICS_ERROR',
        message: 'Failed to calculate analytics',
      });
    }
  });
}
