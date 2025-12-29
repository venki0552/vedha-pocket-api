import { createHash } from 'crypto';
import { CHARS_PER_TOKEN_ESTIMATE } from '../constants/index.js';

/**
 * Estimate token count from text (rough approximation)
 * Uses chars/4 as a simple heuristic
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Generate a content hash for deduplication
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Truncate text to approximate token limit
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

/**
 * Split text into chunks with overlap
 */
export function chunkText(
  text: string,
  targetTokens: number,
  overlapTokens: number
): { text: string; index: number }[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN_ESTIMATE;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN_ESTIMATE;
  
  const chunks: { text: string; index: number }[] = [];
  
  // Split by paragraphs first
  const paragraphs = text.split(/\n\n+/);
  
  let currentChunk = '';
  let chunkIndex = 0;
  
  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;
    
    // If adding this paragraph exceeds target, save current chunk
    if (currentChunk.length + trimmedParagraph.length > targetChars && currentChunk.length > 0) {
      chunks.push({ text: currentChunk.trim(), index: chunkIndex++ });
      
      // Keep overlap from end of current chunk
      const overlapStart = Math.max(0, currentChunk.length - overlapChars);
      currentChunk = currentChunk.slice(overlapStart) + '\n\n' + trimmedParagraph;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmedParagraph;
    }
    
    // Handle very long paragraphs by splitting them
    while (currentChunk.length > targetChars * 1.5) {
      const splitPoint = findSplitPoint(currentChunk, targetChars);
      chunks.push({ text: currentChunk.slice(0, splitPoint).trim(), index: chunkIndex++ });
      
      const overlapStart = Math.max(0, splitPoint - overlapChars);
      currentChunk = currentChunk.slice(overlapStart);
    }
  }
  
  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push({ text: currentChunk.trim(), index: chunkIndex });
  }
  
  return chunks;
}

/**
 * Find a good split point (preferring sentence boundaries)
 */
function findSplitPoint(text: string, targetChars: number): number {
  // Look for sentence end near target
  const searchWindow = 200;
  const searchStart = Math.max(0, targetChars - searchWindow);
  const searchEnd = Math.min(text.length, targetChars + searchWindow);
  const searchText = text.slice(searchStart, searchEnd);
  
  // Find sentence endings
  const sentenceEndRegex = /[.!?]\s+/g;
  let bestSplit = targetChars;
  let match;
  
  while ((match = sentenceEndRegex.exec(searchText)) !== null) {
    const absolutePosition = searchStart + match.index + match[0].length;
    if (Math.abs(absolutePosition - targetChars) < Math.abs(bestSplit - targetChars)) {
      bestSplit = absolutePosition;
    }
  }
  
  return bestSplit;
}

/**
 * Clean extracted text
 */
export function cleanText(text: string): string {
  return text
    // Normalize whitespace
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove excessive newlines
    .replace(/\n{3,}/g, '\n\n')
    // Remove excessive spaces
    .replace(/[ \t]+/g, ' ')
    // Trim lines
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Final trim
    .trim();
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Generate a URL-safe slug
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

/**
 * Extract title from URL
 */
export function extractTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    
    // Get last path segment
    const segments = path.split('/').filter(Boolean);
    if (segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      // Remove file extension and clean up
      return lastSegment
        .replace(/\.[^.]+$/, '')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }
    
    return parsed.hostname;
  } catch {
    return url.slice(0, 50);
  }
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }
  
  throw lastError;
}
