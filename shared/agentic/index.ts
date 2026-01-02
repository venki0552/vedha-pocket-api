/**
 * Agentic RAG Components
 * 
 * This module implements advanced RAG patterns:
 * 1. Query Router - Intent classification to route queries appropriately
 * 2. Self-Reflective RAG - Answer grading for quality assurance
 * 3. Corrective RAG (CRAG) - Relevance grading of retrieved chunks
 * 4. Adaptive Retrieval - Dynamic retrieval parameters
 * 5. Conversation-Aware Retrieval - Context-aware query rewriting
 */

// ============================================================================
// Production Configuration
// ============================================================================

/** Timeout for LLM API calls in milliseconds */
const LLM_TIMEOUT_MS = 10000; // 10 seconds

/** Maximum retries for failed API calls */
const MAX_API_RETRIES = 2;

/** Retry delay base in milliseconds (exponential backoff) */
const RETRY_DELAY_BASE_MS = 500;

// ============================================================================
// Types
// ============================================================================

export type QueryIntent = 
  | 'no_retrieval'    // Greetings, general chat, no sources needed
  | 'simple_lookup'   // Direct fact lookup
  | 'comparison'      // Compare multiple items/concepts
  | 'summarization'   // Summarize content
  | 'analytical'      // Deep analysis, reasoning required
  | 'follow_up';      // Follow-up to previous question

export interface QueryRouterResult {
  intent: QueryIntent;
  confidence: number;
  reasoning: string;
  skipRetrieval: boolean;
  suggestedResponse?: string; // For no_retrieval cases
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RewrittenQuery {
  original: string;
  rewritten: string;
  extractedEntities: string[];
  needsContext: boolean;
}

export interface AdaptiveRetrievalParams {
  chunkCount: number;
  vectorWeight: number;
  ftsWeight: number;
  expansionQueries: number;
}

export type ChunkRelevance = 'relevant' | 'partially_relevant' | 'irrelevant';

export interface GradedChunk {
  chunk: any;
  relevance: ChunkRelevance;
  score: number;
  reasoning: string;
}

export interface CRAGResult {
  gradedChunks: GradedChunk[];
  relevantChunks: any[];
  decision: 'sufficient' | 'needs_expansion' | 'no_relevant_sources';
  avgRelevanceScore: number;
}

export interface AnswerGrade {
  isGrounded: boolean;
  answersQuestion: boolean;
  hasHallucinations: boolean;
  completeness: number; // 0-1
  overallScore: number; // 0-1
  issues: string[];
  shouldRetry: boolean;
}

// ============================================================================
// Production Utilities
// ============================================================================

/**
 * Fetch with timeout and automatic retry with exponential backoff
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = LLM_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_API_RETRIES,
  context: string = 'operation'
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on abort (timeout)
      if (lastError.name === 'AbortError') {
        console.warn(`[Agentic] ${context} timed out`);
        throw lastError;
      }
      
      if (attempt < maxRetries) {
        const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[Agentic] ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Safe JSON parse with fallback
 */
function safeParseJSON<T>(content: string, fallback: T): T {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as T;
    }
  } catch (error) {
    console.warn('[Agentic] JSON parse failed:', error);
  }
  return fallback;
}

// ============================================================================
// 1. Query Router - Intent Classification
// ============================================================================

const QUERY_ROUTER_PROMPT = `You are a query intent classifier for a RAG (Retrieval Augmented Generation) system.
Analyze the user's query and classify its intent.

INTENT TYPES:
- no_retrieval: Greetings, thanks, general chitchat, or questions that don't need document lookup (e.g., "hello", "thanks!", "how are you?", "what can you do?")
- simple_lookup: Direct fact finding, specific information retrieval (e.g., "what is X?", "when did Y happen?")
- comparison: Comparing two or more items, concepts, or documents (e.g., "compare A and B", "what's the difference between X and Y?")
- summarization: Request to summarize content, provide overview (e.g., "summarize the document", "give me an overview of X")
- analytical: Deep analysis, reasoning, inference required (e.g., "why did X cause Y?", "analyze the implications of...")
- follow_up: Follow-up to a previous question, references prior context (e.g., "tell me more", "what about the other one?", "and then?")

Respond ONLY with valid JSON:
{
  "intent": "<intent_type>",
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>",
  "suggestedResponse": "<only for no_retrieval, a friendly response>"
}`;

export async function routeQuery(
  query: string,
  conversationHistory: ConversationMessage[],
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<QueryRouterResult> {
  const defaultResult: QueryRouterResult = {
    intent: 'simple_lookup',
    confidence: 0.5,
    reasoning: 'Using default (fallback)',
    skipRetrieval: false,
  };

  // Quick pattern matching for obvious cases (optimization - skip LLM call)
  const lowerQuery = query.toLowerCase().trim();
  if (/^(hi|hello|hey|greetings|good\s*(morning|afternoon|evening))[\s!.]*$/i.test(lowerQuery)) {
    return {
      intent: 'no_retrieval',
      confidence: 0.95,
      reasoning: 'Greeting detected via pattern match',
      skipRetrieval: true,
      suggestedResponse: 'Hello! How can I help you today? Feel free to ask me anything about your documents.',
    };
  }
  if (/^(thanks|thank\s*you|thx|ty)[\s!.]*$/i.test(lowerQuery)) {
    return {
      intent: 'no_retrieval',
      confidence: 0.95,
      reasoning: 'Thanks detected via pattern match',
      skipRetrieval: true,
      suggestedResponse: "You're welcome! Let me know if you have any other questions.",
    };
  }

  const historyContext = conversationHistory.length > 0
    ? `\n\nConversation history:\n${conversationHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n')}`
    : '';

  try {
    const response = await withRetry(
      () => fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: QUERY_ROUTER_PROMPT },
            { role: 'user', content: `Query: "${query}"${historyContext}` },
          ],
          temperature: 0.1,
          max_tokens: 200,
        }),
      }),
      1, // Only 1 retry for routing (speed matters)
      'Query Router'
    );

    if (!response.ok) {
      console.warn('[Agentic] Query router API returned non-OK, using default');
      return defaultResult;
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    
    const parsed = safeParseJSON<any>(content, null);
    if (parsed) {
      return {
        intent: parsed.intent || 'simple_lookup',
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || '',
        skipRetrieval: parsed.intent === 'no_retrieval',
        suggestedResponse: parsed.suggestedResponse,
      };
    }
  } catch (error) {
    console.error('[Agentic] Query router error:', error);
  }

  return defaultResult;
}

// ============================================================================
// 2. Conversation-Aware Query Rewriting
// ============================================================================

const QUERY_REWRITE_PROMPT = `You are a query rewriter for a RAG system. Your job is to rewrite queries to be self-contained and explicit.

TASKS:
1. Resolve pronouns (it, that, they, this, etc.) using conversation context
2. Expand abbreviations or references to previous topics
3. Make the query self-contained so it can be searched independently
4. Extract key entities mentioned

Respond ONLY with valid JSON:
{
  "rewritten": "<the rewritten, self-contained query>",
  "extractedEntities": ["entity1", "entity2"],
  "needsContext": <true if query references prior conversation, false otherwise>
}`;

export async function rewriteQueryWithContext(
  query: string,
  conversationHistory: ConversationMessage[],
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<RewrittenQuery> {
  // If no history or query seems self-contained, skip rewriting
  if (conversationHistory.length === 0) {
    return {
      original: query,
      rewritten: query,
      extractedEntities: [],
      needsContext: false,
    };
  }

  // Quick check for pronouns/references
  const needsRewrite = /\b(it|this|that|they|them|these|those|the same|another|other|more|also)\b/i.test(query);
  
  if (!needsRewrite) {
    return {
      original: query,
      rewritten: query,
      extractedEntities: [],
      needsContext: false,
    };
  }

  const defaultResult: RewrittenQuery = { 
    original: query, 
    rewritten: query, 
    extractedEntities: [], 
    needsContext: false 
  };

  try {
    const historyContext = conversationHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');

    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: QUERY_REWRITE_PROMPT },
          { role: 'user', content: `Conversation history:\n${historyContext}\n\nCurrent query: "${query}"` },
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
    }, 8000); // 8 second timeout for rewriting

    if (!response.ok) {
      return defaultResult;
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    
    const parsed = safeParseJSON<any>(content, null);
    if (parsed) {
      return {
        original: query,
        rewritten: parsed.rewritten || query,
        extractedEntities: parsed.extractedEntities || [],
        needsContext: parsed.needsContext || false,
      };
    }
  } catch (error) {
    console.warn('[Agentic] Query rewrite error:', error);
  }

  return defaultResult;
}

// ============================================================================
// 3. Adaptive Retrieval Parameters
// ============================================================================

export function getAdaptiveRetrievalParams(
  intent: QueryIntent,
  queryLength: number,
  baseChunkCount: number = 10
): AdaptiveRetrievalParams {
  // Default params
  let params: AdaptiveRetrievalParams = {
    chunkCount: baseChunkCount,
    vectorWeight: 0.7,
    ftsWeight: 0.3,
    expansionQueries: 2,
  };

  switch (intent) {
    case 'no_retrieval':
      // No retrieval needed
      params.chunkCount = 0;
      params.expansionQueries = 0;
      break;

    case 'simple_lookup':
      // Focused retrieval, fewer chunks, more FTS weight for exact matches
      params.chunkCount = Math.min(6, baseChunkCount);
      params.vectorWeight = 0.6;
      params.ftsWeight = 0.4;
      params.expansionQueries = 1;
      break;

    case 'comparison':
      // Need more chunks to find comparable items
      params.chunkCount = Math.min(15, baseChunkCount * 1.5);
      params.vectorWeight = 0.7;
      params.ftsWeight = 0.3;
      params.expansionQueries = 3;
      break;

    case 'summarization':
      // Broader retrieval, more chunks for comprehensive summary
      params.chunkCount = Math.min(20, baseChunkCount * 2);
      params.vectorWeight = 0.8;
      params.ftsWeight = 0.2;
      params.expansionQueries = 2;
      break;

    case 'analytical':
      // Deep retrieval, many chunks, balanced weights
      params.chunkCount = Math.min(15, baseChunkCount * 1.5);
      params.vectorWeight = 0.75;
      params.ftsWeight = 0.25;
      params.expansionQueries = 3;
      break;

    case 'follow_up':
      // Similar to simple lookup but with conversation context weight
      params.chunkCount = Math.min(8, baseChunkCount);
      params.vectorWeight = 0.7;
      params.ftsWeight = 0.3;
      params.expansionQueries = 1;
      break;
  }

  // Adjust based on query length (longer queries might need more context)
  if (queryLength > 100) {
    params.chunkCount = Math.ceil(params.chunkCount * 1.2);
  }

  return params;
}

// ============================================================================
// 4. Corrective RAG (CRAG) - Chunk Relevance Grading
// ============================================================================

const CHUNK_GRADING_PROMPT = `You are a relevance grader for a RAG system. Grade how relevant each chunk is to answering the user's query.

For EACH chunk, provide:
- relevance: "relevant" | "partially_relevant" | "irrelevant"
- score: 0.0-1.0 (how relevant)
- reasoning: brief explanation

Respond ONLY with valid JSON array:
[
  {"index": 0, "relevance": "relevant", "score": 0.9, "reasoning": "Directly answers the question"},
  {"index": 1, "relevance": "irrelevant", "score": 0.1, "reasoning": "Unrelated topic"}
]`;

export async function gradeChunksRelevance(
  query: string,
  chunks: any[],
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<CRAGResult> {
  const fallbackResult = (useChunks: any[]): CRAGResult => ({
    gradedChunks: useChunks.map(c => ({ chunk: c, relevance: 'relevant' as ChunkRelevance, score: 0.7, reasoning: 'Fallback' })),
    relevantChunks: useChunks,
    decision: 'sufficient',
    avgRelevanceScore: 0.7,
  });

  if (chunks.length === 0) {
    return {
      gradedChunks: [],
      relevantChunks: [],
      decision: 'no_relevant_sources',
      avgRelevanceScore: 0,
    };
  }

  // Limit to first 10 chunks for grading (cost optimization)
  const chunksToGrade = chunks.slice(0, 10);
  
  const chunksText = chunksToGrade.map((c, i) => 
    `[Chunk ${i}] Source: ${c.source_title || c.title || 'Untitled'}\n${c.text.substring(0, 500)}${c.text.length > 500 ? '...' : ''}`
  ).join('\n\n');

  try {
    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: CHUNK_GRADING_PROMPT },
          { role: 'user', content: `User Query: "${query}"\n\nChunks to grade:\n${chunksText}` },
        ],
        temperature: 0.1,
        max_tokens: 1000,
      }),
    }, 15000); // 15 second timeout for CRAG grading

    if (!response.ok) {
      console.warn('[Agentic] Chunk grading API failed, using fallback');
      return fallbackResult(chunks);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    
    const grades = safeParseJSON<Array<{index: number; relevance: ChunkRelevance; score: number; reasoning: string}>>(content, []);
    
    if (grades.length > 0) {
      const gradedChunks: GradedChunk[] = chunksToGrade.map((chunk, i) => {
        const grade = grades.find(g => g.index === i) || { relevance: 'partially_relevant' as ChunkRelevance, score: 0.5, reasoning: 'Not graded' };
        return {
          chunk,
          relevance: grade.relevance,
          score: grade.score,
          reasoning: grade.reasoning,
        };
      });

      // Filter relevant chunks (score >= 0.4)
      const relevantChunks = gradedChunks
        .filter(gc => gc.score >= 0.4)
        .map(gc => gc.chunk);

      const avgRelevanceScore = gradedChunks.reduce((sum, gc) => sum + gc.score, 0) / gradedChunks.length;

      // Determine decision
      let decision: CRAGResult['decision'];
      if (relevantChunks.length === 0) {
        decision = 'no_relevant_sources';
      } else if (relevantChunks.length < 3 && avgRelevanceScore < 0.5) {
        decision = 'needs_expansion';
      } else {
        decision = 'sufficient';
      }

      return {
        gradedChunks,
        relevantChunks,
        decision,
        avgRelevanceScore,
      };
    }
  } catch (error) {
    console.warn('[Agentic] Chunk grading error:', error);
  }

  // Fallback - use all chunks
  return fallbackResult(chunks);
}

// ============================================================================
// 5. Self-Reflective RAG - Answer Grading
// ============================================================================

const ANSWER_GRADING_PROMPT = `You are an answer quality grader for a RAG system. Evaluate the assistant's answer based on the sources and user question.

CRITERIA:
1. isGrounded: Does the answer ONLY use information from the provided sources? (true/false)
2. answersQuestion: Does the answer actually address what the user asked? (true/false)
3. hasHallucinations: Does the answer contain information NOT in the sources? (true/false)
4. completeness: How completely does it answer the question? (0.0-1.0)
5. issues: List any specific problems found

Respond ONLY with valid JSON:
{
  "isGrounded": true,
  "answersQuestion": true,
  "hasHallucinations": false,
  "completeness": 0.9,
  "issues": [],
  "overallScore": 0.9,
  "shouldRetry": false
}`;

export async function gradeAnswer(
  query: string,
  answer: string,
  sources: Array<{ title: string; text: string }>,
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<AnswerGrade> {
  const defaultGrade: AnswerGrade = {
    isGrounded: true,
    answersQuestion: true,
    hasHallucinations: false,
    completeness: 0.8,
    overallScore: 0.8,
    issues: [],
    shouldRetry: false,
  };

  // Skip grading for very short answers (likely "not found" messages)
  if (answer.length < 50) {
    return defaultGrade;
  }

  const sourcesText = sources.slice(0, 5).map((s, i) => 
    `[Source ${i + 1}] ${s.title}\n${s.text.substring(0, 300)}...`
  ).join('\n\n');

  try {
    const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: ANSWER_GRADING_PROMPT },
          { role: 'user', content: `User Question: "${query}"\n\nSources:\n${sourcesText}\n\nAssistant Answer:\n${answer.substring(0, 1000)}` },
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
    }, 12000); // 12 second timeout for answer grading

    if (!response.ok) {
      console.warn('[Agentic] Answer grading API failed, using default');
      return defaultGrade;
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    
    const grade = safeParseJSON<any>(content, null);
    if (grade) {
      const overallScore = grade.overallScore ?? 
        ((grade.isGrounded ? 0.3 : 0) + 
         (grade.answersQuestion ? 0.3 : 0) + 
         (!grade.hasHallucinations ? 0.2 : 0) + 
         ((grade.completeness || 0.5) * 0.2));

      const shouldRetry = !grade.isGrounded || 
                          !grade.answersQuestion || 
                          grade.hasHallucinations || 
                          (grade.completeness || 0.8) < 0.4;

      return {
        isGrounded: grade.isGrounded ?? true,
        answersQuestion: grade.answersQuestion ?? true,
        hasHallucinations: grade.hasHallucinations ?? false,
        completeness: grade.completeness ?? 0.8,
        overallScore,
        issues: grade.issues || [],
        shouldRetry,
      };
    }
  } catch (error) {
    console.warn('[Agentic] Answer grading error:', error);
  }

  return defaultGrade;
}

// ============================================================================
// Streaming versions for real-time feedback
// ============================================================================

export interface AgenticPipelineEvents {
  type: 'routing' | 'rewriting' | 'grading_chunks' | 'grading_answer' | 'retry';
  payload: any;
}

/**
 * Run the full agentic pipeline and yield events for real-time feedback
 */
export async function* runAgenticPipeline(
  query: string,
  conversationHistory: ConversationMessage[],
  apiKey: string,
  baseUrl: string,
  model: string
): AsyncGenerator<AgenticPipelineEvents, { routerResult: QueryRouterResult; rewrittenQuery: RewrittenQuery; retrievalParams: AdaptiveRetrievalParams }> {
  // Step 1: Route query
  yield { type: 'routing', payload: { status: 'Analyzing query intent...' } };
  const routerResult = await routeQuery(query, conversationHistory, apiKey, baseUrl, model);
  yield { type: 'routing', payload: routerResult };

  // Step 2: Rewrite query with context (if not no_retrieval)
  let rewrittenQuery: RewrittenQuery = { original: query, rewritten: query, extractedEntities: [], needsContext: false };
  
  if (!routerResult.skipRetrieval && conversationHistory.length > 0) {
    yield { type: 'rewriting', payload: { status: 'Rewriting query with context...' } };
    rewrittenQuery = await rewriteQueryWithContext(query, conversationHistory, apiKey, baseUrl, model);
    yield { type: 'rewriting', payload: rewrittenQuery };
  }

  // Step 3: Get adaptive retrieval parameters
  const retrievalParams = getAdaptiveRetrievalParams(routerResult.intent, query.length);

  return { routerResult, rewrittenQuery, retrievalParams };
}
