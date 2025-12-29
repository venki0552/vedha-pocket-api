import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { askSchema, RAG_CONTEXT_CHUNKS, VECTOR_WEIGHT, FTS_WEIGHT } from '@vedha/shared';
import { OpenRouterEmbeddingProvider, OpenRouterChatProvider, type Citation } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { env } from '../config/env.js';

export async function askRoutes(app: FastifyInstance) {
  // All ask routes require auth
  app.addHook('preHandler', requireAuth);

  // RAG-powered question answering
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = askSchema.parse(request.body);

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
      // Get or create conversation
      let conversationId = body.conversation_id;
      
      if (!conversationId) {
        const { data: conversation, error: convError } = await user
          .from('conversations')
          .insert({
            org_id: pocketMember.org_id,
            pocket_id: body.pocket_id,
            created_by: userId,
          })
          .select()
          .single();

        if (convError) {
          app.log.error(convError);
          return reply.status(500).send({
            code: 'DATABASE_ERROR',
            message: 'Failed to create conversation',
          });
        }
        conversationId = conversation.id;
      }

      // Save user message
      await user.from('messages').insert({
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        conversation_id: conversationId,
        role: 'user',
        content: body.query,
        citations: null,
      });

      // Get query embedding
      const embeddingProvider = new OpenRouterEmbeddingProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        embedModel: env.OPENROUTER_EMBED_MODEL,
      });

      const [queryEmbedding] = await embeddingProvider.embed([body.query]);

      // Retrieve relevant chunks using hybrid search
      const { data: chunks, error: searchError } = await service.rpc('hybrid_search', {
        query_embedding: `[${queryEmbedding.join(',')}]`,
        query_text: body.query,
        target_pocket_id: body.pocket_id,
        match_count: RAG_CONTEXT_CHUNKS,
        vector_weight: VECTOR_WEIGHT,
        fts_weight: FTS_WEIGHT,
      });

      if (searchError) {
        app.log.error(searchError);
        return reply.status(500).send({
          code: 'SEARCH_ERROR',
          message: 'Failed to retrieve relevant context',
        });
      }

      // Check if we have any chunks
      if (!chunks || chunks.length === 0) {
        // No sources found - respond appropriately
        const noSourcesResponse = "I couldn't find any relevant information in your saved sources. Please try uploading some documents or saving URLs first.";
        
        const { data: assistantMessage, error: msgError } = await user
          .from('messages')
          .insert({
            org_id: pocketMember.org_id,
            pocket_id: body.pocket_id,
            conversation_id: conversationId,
            role: 'assistant',
            content: noSourcesResponse,
            citations: [],
          })
          .select()
          .single();

        if (msgError) {
          app.log.error(msgError);
        }

        return {
          data: {
            answer: noSourcesResponse,
            citations: [],
            conversation_id: conversationId,
            message_id: assistantMessage?.id,
          },
        };
      }

      // Prepare sources for LLM
      const sources = chunks.map((chunk: any) => ({
        id: chunk.chunk_id,
        source_id: chunk.source_id,
        title: chunk.source_title,
        page: chunk.page,
        text: chunk.text,
      }));

      // Call chat provider
      const chatProvider = new OpenRouterChatProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        chatModel: env.OPENROUTER_CHAT_MODEL,
        fallbackChatModel: env.OPENROUTER_FALLBACK_CHAT_MODEL,
      });

      const result = await chatProvider.complete(
        [{ role: 'user', content: body.query }],
        sources
      );

      // Map citations to include correct source_id
      const enrichedCitations: Citation[] = result.citations.map((c) => {
        const source = sources.find((s: any) => s.id === c.chunk_id);
        return {
          ...c,
          source_id: source?.source_id || c.source_id,
        };
      });

      // Save assistant message
      const { data: assistantMessage, error: msgError } = await user
        .from('messages')
        .insert({
          org_id: pocketMember.org_id,
          pocket_id: body.pocket_id,
          conversation_id: conversationId,
          role: 'assistant',
          content: result.answer,
          citations: enrichedCitations,
        })
        .select()
        .single();

      if (msgError) {
        app.log.error(msgError);
      }

      // Log audit event
      await service.from('audit_events').insert({
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        user_id: userId,
        event_type: 'ask',
        metadata: { 
          query: body.query, 
          chunks_used: chunks.length,
          model: result.model,
        },
      });

      return {
        data: {
          answer: result.answer,
          citations: enrichedCitations,
          conversation_id: conversationId,
          message_id: assistantMessage?.id,
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'ASK_ERROR',
        message: 'Failed to generate response',
      });
    }
  });

  // Get conversation history
  app.get('/:conversationId/messages', async (request: FastifyRequest<{ Params: { conversationId: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { conversationId } = request.params;

    const { data: messages, error } = await user
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch messages',
      });
    }

    return { data: messages };
  });
}
