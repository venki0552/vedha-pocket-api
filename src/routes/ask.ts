import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { askSchema, RAG_CONTEXT_CHUNKS, VECTOR_WEIGHT, FTS_WEIGHT } from '@vedha/shared';
import { OpenRouterEmbeddingProvider, OpenRouterChatProvider, type Citation } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { env } from '../config/env.js';

// Number of additional search queries to generate
const MULTI_QUERY_COUNT = 2;

/**
 * Generate additional search queries using LLM for better retrieval coverage
 */
async function generateSearchQueries(
  originalQuery: string,
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<string[]> {
  const systemPrompt = `You are a search query generator. Given a user question, generate ${MULTI_QUERY_COUNT} alternative search queries that would help find relevant information.
Rules:
- Keep queries concise (max 10 words each)
- Make queries diverse but relevant to the original question
- Do not add new concepts not present in the original question
- Return ONLY a JSON array of strings, nothing else`;

  const userPrompt = `Generate ${MULTI_QUERY_COUNT} alternative search queries for: "${originalQuery}"

Return as JSON array, e.g.: ["query 1", "query 2"]`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      console.warn('Failed to generate additional queries, using original only');
      return [originalQuery];
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
    };

    const content = data.choices[0]?.message?.content || '';
    
    // Parse JSON array from response
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      const queries = JSON.parse(match[0]) as string[];
      // Return original + generated queries
      return [originalQuery, ...queries.slice(0, MULTI_QUERY_COUNT)];
    }
  } catch (error) {
    console.warn('Error generating search queries:', error);
  }
  
  return [originalQuery];
}

/**
 * Search with multiple queries and fuse/deduplicate results
 */
async function multiQuerySearch(
  queries: string[],
  pocketId: string,
  embeddingProvider: OpenRouterEmbeddingProvider,
  service: any
): Promise<any[]> {
  // Generate embeddings for all queries
  const embeddings = await embeddingProvider.embed(queries);
  
  // Search with each query
  const allResults: Map<string, any> = new Map();
  
  for (let i = 0; i < queries.length; i++) {
    const { data: chunks, error } = await service.rpc('hybrid_search', {
      query_embedding: `[${embeddings[i].join(',')}]`,
      query_text: queries[i],
      target_pocket_id: pocketId,
      match_count: RAG_CONTEXT_CHUNKS,
      vector_weight: VECTOR_WEIGHT,
      fts_weight: FTS_WEIGHT,
    });

    if (error) {
      console.warn(`Search failed for query "${queries[i]}":`, error);
      continue;
    }

    // Deduplicate by chunk ID and aggregate scores
    for (const chunk of (chunks || [])) {
      const existing = allResults.get(chunk.id);
      if (existing) {
        // Average the scores
        existing.similarity = (existing.similarity + chunk.similarity) / 2;
        existing.queryCount = (existing.queryCount || 1) + 1;
      } else {
        allResults.set(chunk.id, { ...chunk, queryCount: 1 });
      }
    }
  }
  
  // Sort by combined score and return top results
  const results = Array.from(allResults.values())
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, RAG_CONTEXT_CHUNKS);
  
  console.log(`🔍 Multi-query search: ${queries.length} queries, ${allResults.size} unique chunks, returning ${results.length}`);
  
  return results;
}

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

      // Create embedding provider
      const embeddingProvider = new OpenRouterEmbeddingProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        embedModel: env.OPENROUTER_EMBED_MODEL,
      });

      // Generate multiple search queries for better retrieval
      const searchQueries = await generateSearchQueries(
        body.query,
        env.OPENROUTER_API_KEY,
        env.OPENROUTER_BASE_URL,
        env.OPENROUTER_CHAT_MODEL
      );
      
      app.log.info(`Multi-query RAG: ${searchQueries.length} queries: ${searchQueries.join(' | ')}`);

      // Retrieve relevant chunks using multi-query hybrid search
      const chunks = await multiQuerySearch(
        searchQueries,
        body.pocket_id,
        embeddingProvider,
        service
      );

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
