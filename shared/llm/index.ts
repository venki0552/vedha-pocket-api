import type { Citation } from '../types/database.js';
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_CHAT_MODEL,
  FALLBACK_CHAT_MODEL,
} from '../constants/index.js';

// Provider interfaces
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  dimension: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  answer: string;
  citations: Citation[];
  model: string;
}

export interface ChatProvider {
  complete(
    messages: ChatMessage[],
    sources: { id: string; title: string; page: number | null; text: string }[]
  ): Promise<ChatCompletionResult>;
  model: string;
}

// OpenRouter configuration
export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  embedModel?: string;
  chatModel?: string;
  fallbackChatModel?: string;
}

// OpenRouter Embedding Provider
export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension: number = 3072; // text-embedding-3-large dimension
  private apiKey: string;
  private baseUrl: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';
    this.model = config.embedModel || DEFAULT_EMBED_MODEL;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vedha.pocket',
        'X-Title': 'Vedha Pocket',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter embedding failed: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index to ensure correct order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(item => item.embedding);
  }
}

// OpenRouter Chat Provider
export class OpenRouterChatProvider implements ChatProvider {
  readonly model: string;
  private fallbackModel: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';
    this.model = config.chatModel || DEFAULT_CHAT_MODEL;
    this.fallbackModel = config.fallbackChatModel || FALLBACK_CHAT_MODEL;
  }

  async complete(
    messages: ChatMessage[],
    sources: { id: string; title: string; page: number | null; text: string }[]
  ): Promise<ChatCompletionResult> {
    // Build system prompt with anti-hallucination instructions
    const systemPrompt = this.buildSystemPrompt(sources);
    
    const fullMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    let usedModel = this.model;
    let response = await this.callOpenRouter(fullMessages, this.model);

    // Fallback if primary model fails
    if (!response.ok && this.fallbackModel !== this.model) {
      console.warn(`Primary model ${this.model} failed, trying fallback ${this.fallbackModel}`);
      usedModel = this.fallbackModel;
      response = await this.callOpenRouter(fullMessages, this.fallbackModel);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter chat failed: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
    };

    const content = data.choices[0]?.message?.content || '';
    
    // Parse citations from the response
    const citations = this.extractCitations(content, sources);

    return {
      answer: content,
      citations,
      model: usedModel,
    };
  }

  private async callOpenRouter(messages: ChatMessage[], model: string): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://vedha.pocket',
        'X-Title': 'Vedha Pocket',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });
  }

  private buildSystemPrompt(
    sources: { id: string; title: string; page: number | null; text: string }[]
  ): string {
    let sourcesText = '';
    
    sources.forEach((source, idx) => {
      const pageInfo = source.page ? ` (Page ${source.page})` : '';
      sourcesText += `\n---SOURCE ${idx + 1}: [${source.title}]${pageInfo}---\n`;
      sourcesText += source.text;
      sourcesText += `\n---END SOURCE ${idx + 1}---\n`;
    });

    return `You are a helpful assistant that answers questions based ONLY on the provided sources.

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
  }

  private extractCitations(
    content: string,
    sources: { id: string; title: string; page: number | null; text: string }[]
  ): Citation[] {
    const citations: Citation[] = [];
    const citedSources = new Set<number>();
    
    // Find all [Source N] patterns
    const pattern = /\[Source\s*(\d+)\]/gi;
    let match;
    
    while ((match = pattern.exec(content)) !== null) {
      const sourceNum = parseInt(match[1], 10) - 1; // Convert to 0-indexed
      if (sourceNum >= 0 && sourceNum < sources.length && !citedSources.has(sourceNum)) {
        citedSources.add(sourceNum);
        const source = sources[sourceNum];
        citations.push({
          chunk_id: source.id,
          source_id: source.id, // Will be updated with actual source_id in API
          title: source.title,
          page: source.page,
          snippet: source.text.slice(0, 200) + (source.text.length > 200 ? '...' : ''),
        });
      }
    }
    
    return citations;
  }
}

// Factory function
export function createLLMProviders(config: OpenRouterConfig): {
  embedding: EmbeddingProvider;
  chat: ChatProvider;
} {
  return {
    embedding: new OpenRouterEmbeddingProvider(config),
    chat: new OpenRouterChatProvider(config),
  };
}
