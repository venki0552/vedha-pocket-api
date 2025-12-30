import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { OpenRouterEmbeddingProvider } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { getEncryptedKey } from '../services/encryption.js';
import { env } from '../config/env.js';

// Number of additional search queries to generate
const MULTI_QUERY_COUNT = 2;

// Validation schemas
const askMemorySchema = z.object({
  org_id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  question: z.string().min(1).max(5000),
});

// SSE event types
type SSEEventType = 'status' | 'queries' | 'sources' | 'token' | 'done' | 'error' | 'thinking';

interface SSEEvent {
  type: SSEEventType;
  payload: any;
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

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

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse JSON array from response
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      const queries = JSON.parse(match[0]) as string[];
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
async function multiQueryMemorySearch(
  queries: string[],
  userId: string,
  orgId: string,
  embeddingProvider: OpenRouterEmbeddingProvider,
  service: any
): Promise<any[]> {
  // Generate embeddings for all queries
  const embeddings = await embeddingProvider.embed(queries);

  // Search with each query
  const allResults: Map<string, any> = new Map();

  for (let i = 0; i < queries.length; i++) {
    const { data: chunks, error } = await service.rpc('memory_hybrid_search', {
      p_user_id: userId,
      p_org_id: orgId,
      p_query_embedding: `[${embeddings[i].join(',')}]`,
      p_query_text: queries[i],
      p_limit: 10,
      p_semantic_weight: 0.7,
    });

    if (error) {
      console.warn(`Search failed for query "${queries[i]}":`, error);
      continue;
    }

    // Deduplicate by chunk ID and aggregate scores
    for (const chunk of chunks || []) {
      const existing = allResults.get(chunk.chunk_id);
      if (existing) {
        // Average the scores
        existing.combined_score = (existing.combined_score + chunk.combined_score) / 2;
        existing.queryCount = (existing.queryCount || 1) + 1;
      } else {
        allResults.set(chunk.chunk_id, { ...chunk, queryCount: 1 });
      }
    }
  }

  // Sort by combined score and return top results
  const results = Array.from(allResults.values())
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, 10);

  return results;
}

/**
 * Stream chat completion with fallback model support
 */
async function* streamChatCompletion(
  memoriesText: string,
  userMessage: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  fallbackModel: string
): AsyncGenerator<SSEEvent, { answer: string; model: string }, void> {
  const systemPrompt = `You are a helpful assistant that answers questions based ONLY on the user's memories.

CRITICAL INSTRUCTIONS:
1. NEVER hallucinate or make up information. Only use facts from the provided memories.
2. If the answer is not in the memories, say "I couldn't find this information in your memories."
3. Always cite your sources using [Memory N] format where N is the memory number.
4. Be precise and factual. Do not speculate or add information beyond what's in the memories.
5. Provide direct quotes when appropriate, using quotation marks.

YOUR MEMORIES:
${memoriesText}

Remember: Only answer from the memories above. If you cannot find relevant information, clearly state this.`;

  let currentModel = model;
  let attempt = 0;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: currentModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: true,
          max_tokens: 2000,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`API returned ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullAnswer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            
            // Check for reasoning/thinking content
            const reasoning = parsed.choices?.[0]?.delta?.reasoning;
            if (reasoning) {
              yield { type: 'thinking', payload: reasoning };
            }

            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              fullAnswer += content;
              yield { type: 'token', payload: content };
            }
          } catch {
            continue;
          }
        }
      }

      return { answer: fullAnswer, model: currentModel };
    } catch (error) {
      console.error(`Chat completion failed with ${currentModel}:`, error);
      if (attempt === 0 && fallbackModel && fallbackModel !== currentModel) {
        currentModel = fallbackModel;
        attempt++;
        continue;
      }
      throw error;
    }
  }

  throw new Error('All chat completion attempts failed');
}

interface Citation {
  chunk_id: string;
  memory_id: string;
  title: string | null;
  color: string;
  snippet: string;
}

/**
 * Extract citations from answer text ([Memory N] format)
 */
function extractCitations(answer: string, sources: any[]): Citation[] {
  const citations: Citation[] = [];
  const citedSources = new Set<number>();
  
  const citationPattern = /\[Memory\s*(\d+)\]/gi;
  let match;

  while ((match = citationPattern.exec(answer)) !== null) {
    const sourceIndex = parseInt(match[1], 10) - 1;
    if (sourceIndex >= 0 && sourceIndex < sources.length && !citedSources.has(sourceIndex)) {
      citedSources.add(sourceIndex);
      const source = sources[sourceIndex];
      citations.push({
        chunk_id: source.chunk_id,
        memory_id: source.memory_id,
        title: source.memory_title || 'Untitled',
        color: source.memory_color,
        snippet: source.chunk_text.substring(0, 200) + '...',
      });
    }
  }

  return citations;
}

export async function generalChatRoutes(app: FastifyInstance) {
  // All routes require auth
  app.addHook('preHandler', requireAuth);

  // List conversations
  app.get('/conversations', async (request: FastifyRequest<{ Querystring: { org_id?: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { org_id } = request.query;

    let query = user
      .from('general_conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (org_id) {
      query = query.eq('org_id', org_id);
    }

    const { data: conversations, error } = await query;

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch conversations',
      });
    }

    return { data: conversations };
  });

  // Get conversation messages
  app.get('/conversations/:id/messages', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    // Verify ownership
    const { data: conversation, error: convError } = await user
      .from('general_conversations')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (convError || !conversation) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Conversation not found',
      });
    }

    const { data: messages, error } = await user
      .from('general_messages')
      .select('*')
      .eq('conversation_id', id)
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

  // Delete conversation
  app.delete('/conversations/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    const { error } = await user
      .from('general_conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete conversation',
      });
    }

    return reply.status(204).send();
  });

  // Streaming RAG-powered question answering over memories
  app.post('/ask/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = askMemorySchema.parse(request.body);

    // Verify user is member of org
    const { data: membership, error: memberError } = await user
      .from('memberships')
      .select('id')
      .eq('org_id', body.org_id)
      .eq('user_id', userId)
      .single();

    if (memberError || !membership) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You are not a member of this organization',
      });
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (event: SSEEvent) => {
      reply.raw.write(formatSSE(event));
    };

    try {
      // Get or create conversation
      let conversationId = body.conversation_id;

      if (!conversationId) {
        const { data: conversation, error: convError } = await user
          .from('general_conversations')
          .insert({
            org_id: body.org_id,
            user_id: userId,
            title: body.question.substring(0, 100),
          })
          .select()
          .single();

        if (convError) {
          throw new Error('Failed to create conversation');
        }
        conversationId = conversation.id;
      }

      sendEvent({ type: 'status', payload: 'Searching your memories...' });

      // Get user's API key
      const { data: settings } = await service
        .from('user_settings')
        .select('openrouter_api_key_encrypted')
        .eq('user_id', userId)
        .single();

      let apiKey: string;
      if (settings?.openrouter_api_key_encrypted) {
        apiKey = await getEncryptedKey(settings.openrouter_api_key_encrypted, env.ENCRYPTION_KEY);
      } else if (env.OPENROUTER_API_KEY_SHARED) {
        apiKey = env.OPENROUTER_API_KEY_SHARED;
      } else {
        throw new Error('No API key configured');
      }

      const baseUrl = 'https://openrouter.ai/api/v1';
      const embeddingModel = 'openai/text-embedding-3-small';
      const chatModel = env.DEFAULT_CHAT_MODEL || 'google/gemma-3-27b-it:free';
      const fallbackModel = env.OPENROUTER_FALLBACK_CHAT_MODEL || 'google/gemma-3-27b-it:free';

      // Step 1: Generate search queries for better retrieval
      sendEvent({ type: 'status', payload: 'Generating search queries...' });
      const searchQueries = await generateSearchQueries(body.question, apiKey, baseUrl, chatModel);
      sendEvent({ type: 'queries', payload: searchQueries });

      // Step 2: Create embedding provider
      const embeddingProvider = new OpenRouterEmbeddingProvider({
        apiKey,
        baseUrl,
        embedModel: embeddingModel,
        chatModel,
      });

      // Step 3: Multi-query search
      sendEvent({ type: 'status', payload: `Searching ${searchQueries.length} queries...` });
      const chunks = await multiQueryMemorySearch(
        searchQueries,
        userId,
        body.org_id,
        embeddingProvider,
        service
      );

      if (!chunks || chunks.length === 0) {
        sendEvent({ type: 'status', payload: 'No relevant memories found' });
        sendEvent({ 
          type: 'token', 
          payload: "I couldn't find any relevant information in your published memories. Try publishing some memories first, or ask a different question." 
        });
        
        // Save messages
        await user.from('general_messages').insert([
          { org_id: body.org_id, conversation_id: conversationId, role: 'user', content: body.question },
          { org_id: body.org_id, conversation_id: conversationId, role: 'assistant', content: "I couldn't find any relevant information in your published memories." },
        ]);

        sendEvent({ type: 'done', payload: { conversation_id: conversationId, citations: [] } });
        reply.raw.end();
        return;
      }

      // Send sources
      const sourcePreviews = chunks.map((c: any, i: number) => ({
        index: i + 1,
        memory_id: c.memory_id,
        title: c.memory_title || 'Untitled',
        color: c.memory_color,
        snippet: c.chunk_text.substring(0, 150) + '...',
      }));
      sendEvent({ type: 'sources', payload: sourcePreviews });
      sendEvent({ type: 'status', payload: `Retrieved ${chunks.length} chunks, generating answer...` });

      // Build context for LLM
      let memoriesText = '';
      chunks.forEach((c: any, i: number) => {
        memoriesText += `\n---MEMORY ${i + 1}: [${c.memory_title || 'Untitled'}]---\n`;
        memoriesText += c.chunk_text;
        memoriesText += `\n---END MEMORY ${i + 1}---\n`;
      });

      // Step 4: Stream chat completion with fallback support
      const chatGen = streamChatCompletion(
        memoriesText,
        body.question,
        apiKey,
        baseUrl,
        chatModel,
        fallbackModel
      );

      let chatResult = await chatGen.next();
      while (!chatResult.done) {
        sendEvent(chatResult.value);
        chatResult = await chatGen.next();
      }

      const { answer: fullAnswer, model: usedModel } = chatResult.value!;

      // Extract citations
      const citations = extractCitations(fullAnswer, chunks);

      // Save messages
      await user.from('general_messages').insert([
        { org_id: body.org_id, conversation_id: conversationId, role: 'user', content: body.question },
        { org_id: body.org_id, conversation_id: conversationId, role: 'assistant', content: fullAnswer, citations },
      ]);

      // Update conversation title if new
      if (!body.conversation_id) {
        await user
          .from('general_conversations')
          .update({ title: body.question.substring(0, 100) })
          .eq('id', conversationId);
      }

      sendEvent({ type: 'done', payload: { conversation_id: conversationId, citations, model: usedModel } });
    } catch (error: any) {
      app.log.error(error);
      sendEvent({ type: 'error', payload: error.message || 'An error occurred' });
    }

    reply.raw.end();
  });
}
