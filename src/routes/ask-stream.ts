import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { askSchema, RAG_CONTEXT_CHUNKS, VECTOR_WEIGHT, FTS_WEIGHT } from '@vedha/shared';
import { OpenRouterEmbeddingProvider, type Citation } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { env } from '../config/env.js';

// Number of additional search queries to generate
const MULTI_QUERY_COUNT = 2;

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
 * Streaming version that yields thinking tokens
 */
async function* generateSearchQueriesStream(
  originalQuery: string,
  apiKey: string,
  baseUrl: string,
  model: string
): AsyncGenerator<SSEEvent, string[], void> {
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
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      console.warn('Failed to generate additional queries, using original only');
      return [originalQuery];
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

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
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            fullContent += content;
          }
        } catch {
          continue;
        }
      }
    }

    // Parse JSON array from response
    const match = fullContent.match(/\[[\s\S]*\]/);
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
    for (const chunk of chunks || []) {
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

  return results;
}

/**
 * Stream chat completion with token-by-token output
 */
async function* streamChatCompletion(
  sources: any[],
  userMessage: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  fallbackModel: string
): AsyncGenerator<SSEEvent, { answer: string; model: string }, void> {
  // Build sources text with proper formatting
  let sourcesText = '';
  sources.forEach((s, i) => {
    const pageInfo = s.page ? ` (Page ${s.page})` : '';
    sourcesText += `\n---SOURCE ${i + 1}: [${s.title || 'Untitled'}]${pageInfo}---\n`;
    sourcesText += s.text;
    sourcesText += `\n---END SOURCE ${i + 1}---\n`;
  });

  const systemPrompt = `You are a helpful assistant that answers questions based ONLY on the provided sources.

CRITICAL INSTRUCTIONS:
1. NEVER hallucinate or make up information. Only use facts from the provided sources.
2. If the answer is not in the sources, say "I couldn't find this information in your saved sources."
3. Always cite your sources using [Source N] format where N is the source number.
4. Be precise and factual. Do not speculate or add information beyond what's in the sources.
5. If sources contradict each other, mention this discrepancy.
6. Provide direct quotes when appropriate, using quotation marks.

AVAILABLE SOURCES:
${sourcesText}

Remember: Only answer from the sources above. If you cannot find relevant information, clearly state this. Do NOT make up facts.`;

  const userPrompt = userMessage;

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
            { role: 'user', content: userPrompt },
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

/**
 * Extract citations from answer text ([Source N] format)
 */
function extractCitations(answer: string, sources: any[]): Citation[] {
  const citations: Citation[] = [];
  const citedSources = new Set<number>();
  
  // Find all [Source N] patterns
  const citationPattern = /\[Source\s*(\d+)\]/gi;
  let match;

  while ((match = citationPattern.exec(answer)) !== null) {
    const sourceIndex = parseInt(match[1], 10) - 1; // Convert 1-based to 0-based index
    if (sourceIndex >= 0 && sourceIndex < sources.length && !citedSources.has(sourceIndex)) {
      citedSources.add(sourceIndex);
      const source = sources[sourceIndex];
      citations.push({
        chunk_id: source.id,
        source_id: source.source_id,
        title: source.title || 'Untitled',
        page: source.page || null,
        snippet: source.text.substring(0, 200) + '...',
      });
    }
  }

  return citations;
}

export async function askStreamRoutes(app: FastifyInstance) {
  // All routes require auth
  app.addHook('preHandler', requireAuth);

  // Streaming RAG-powered question answering
  app.post('/stream', async (request: FastifyRequest, reply: FastifyReply) => {
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
          .from('conversations')
          .insert({
            org_id: pocketMember.org_id,
            pocket_id: body.pocket_id,
            created_by: userId,
          })
          .select()
          .single();

        if (convError) {
          sendEvent({ type: 'error', payload: 'Failed to create conversation' });
          reply.raw.end();
          return;
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

      // Step 1: Generate search queries
      sendEvent({ type: 'status', payload: 'Generating search queries...' });

      const queryGen = generateSearchQueriesStream(
        body.query,
        env.OPENROUTER_API_KEY,
        env.OPENROUTER_BASE_URL,
        env.OPENROUTER_CHAT_MODEL
      );

      let searchQueries: string[] = [body.query];
      let genResult = await queryGen.next();
      while (!genResult.done) {
        if (genResult.value.type === 'thinking') {
          sendEvent(genResult.value);
        }
        genResult = await queryGen.next();
      }
      if (genResult.value) {
        searchQueries = genResult.value;
      }

      sendEvent({ type: 'queries', payload: searchQueries });

      // Step 2: Retrieve relevant chunks
      sendEvent({ type: 'status', payload: `Searching ${searchQueries.length} queries...` });

      const embeddingProvider = new OpenRouterEmbeddingProvider({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        embedModel: env.OPENROUTER_EMBED_MODEL,
      });

      const chunks = await multiQuerySearch(
        searchQueries,
        body.pocket_id,
        embeddingProvider,
        service
      );

      if (!chunks || chunks.length === 0) {
        const noSourcesResponse = "I couldn't find any relevant information in your saved sources.";

        await user.from('messages').insert({
          org_id: pocketMember.org_id,
          pocket_id: body.pocket_id,
          conversation_id: conversationId,
          role: 'assistant',
          content: noSourcesResponse,
          citations: [],
        });

        sendEvent({ type: 'done', payload: { answer: noSourcesResponse, citations: [], conversation_id: conversationId } });
        reply.raw.end();
        return;
      }

      // Prepare sources
      const sources = chunks.map((chunk: any) => ({
        id: chunk.chunk_id,
        source_id: chunk.source_id,
        title: chunk.source_title,
        page: chunk.page,
        text: chunk.text,
      }));

      // Send sources info
      const uniqueSources = [...new Map(sources.map(s => [s.source_id, { source_id: s.source_id, title: s.title }])).values()];
      sendEvent({ type: 'sources', payload: uniqueSources });
      sendEvent({ type: 'status', payload: `Retrieved ${sources.length} chunks from ${uniqueSources.length} sources` });

      // Step 3: Generate answer with streaming
      sendEvent({ type: 'status', payload: 'Generating answer...' });

      const chatGen = streamChatCompletion(
        sources,
        body.query,
        env.OPENROUTER_API_KEY,
        env.OPENROUTER_BASE_URL,
        env.OPENROUTER_CHAT_MODEL,
        env.OPENROUTER_FALLBACK_CHAT_MODEL
      );

      let chatResult = await chatGen.next();
      while (!chatResult.done) {
        sendEvent(chatResult.value);
        chatResult = await chatGen.next();
      }

      const { answer, model } = chatResult.value!;
      const citations = extractCitations(answer, sources);

      // Save assistant message
      const { data: assistantMessage } = await user
        .from('messages')
        .insert({
          org_id: pocketMember.org_id,
          pocket_id: body.pocket_id,
          conversation_id: conversationId,
          role: 'assistant',
          content: answer,
          citations: citations,
        })
        .select()
        .single();

      // Log audit event
      await service.from('audit_events').insert({
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        user_id: userId,
        event_type: 'ask',
        metadata: {
          query: body.query,
          chunks_used: chunks.length,
          model: model,
          streaming: true,
        },
      });

      // Send done event
      sendEvent({
        type: 'done',
        payload: {
          answer,
          citations,
          conversation_id: conversationId,
          message_id: assistantMessage?.id,
        },
      });
    } catch (error) {
      app.log.error(error);
      sendEvent({ type: 'error', payload: 'Failed to generate response' });
    } finally {
      reply.raw.end();
    }
  });
}
