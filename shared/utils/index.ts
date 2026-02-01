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

/**
 * SSRF Protection: Validates a URL to prevent Server-Side Request Forgery attacks.
 * Blocks access to:
 * - Private/internal IP ranges (10.x, 172.16-31.x, 192.168.x)
 * - Localhost and loopback addresses
 * - Link-local addresses (169.254.x)
 * - Cloud metadata endpoints (169.254.169.254)
 * - IPv6 private/localhost addresses
 * - Non-HTTP(S) protocols
 * 
 * @throws Error if the URL is potentially malicious
 */
export function validateUrlForSsrf(url: string): URL {
  let parsedUrl: URL;
  
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }
  
  // Only allow http and https protocols
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Protocol not allowed: ${parsedUrl.protocol}. Only http and https are permitted.`);
  }
  
  const hostname = parsedUrl.hostname.toLowerCase();
  
  // Block localhost and common localhost aliases
  const localhostPatterns = [
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    '[::1]',
    '0177.0.0.1', // Octal representation of 127.0.0.1
    '2130706433', // Decimal representation of 127.0.0.1
    '0x7f.0.0.1', // Hex representation
    '127.0.0.1.nip.io', // DNS rebinding service
    'localtest.me',
    'lvh.me',
  ];
  
  if (localhostPatterns.some(pattern => hostname === pattern || hostname.endsWith('.' + pattern))) {
    throw new Error('Access to localhost is not allowed');
  }
  
  // Check if hostname is an IP address and validate it
  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = hostname.match(ipv4Pattern);
  
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    
    // Validate octets are in valid range
    if (octets.some(octet => octet > 255)) {
      throw new Error('Invalid IP address');
    }
    
    const [a, b, c, d] = octets;
    
    // Block private IPv4 ranges
    // 10.0.0.0/8
    if (a === 10) {
      throw new Error('Access to private IP ranges is not allowed');
    }
    
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) {
      throw new Error('Access to private IP ranges is not allowed');
    }
    
    // 192.168.0.0/16
    if (a === 192 && b === 168) {
      throw new Error('Access to private IP ranges is not allowed');
    }
    
    // 127.0.0.0/8 (loopback)
    if (a === 127) {
      throw new Error('Access to loopback addresses is not allowed');
    }
    
    // 169.254.0.0/16 (link-local, includes AWS metadata at 169.254.169.254)
    if (a === 169 && b === 254) {
      throw new Error('Access to link-local and cloud metadata addresses is not allowed');
    }
    
    // 0.0.0.0/8 (current network)
    if (a === 0) {
      throw new Error('Access to current network addresses is not allowed');
    }
    
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) {
      throw new Error('Access to carrier-grade NAT addresses is not allowed');
    }
    
    // 198.18.0.0/15 (benchmark testing)
    if (a === 198 && (b === 18 || b === 19)) {
      throw new Error('Access to benchmark testing addresses is not allowed');
    }
    
    // Broadcast and multicast (224.0.0.0/4 through 255.255.255.255)
    if (a >= 224) {
      throw new Error('Access to multicast and broadcast addresses is not allowed');
    }
  }
  
  // Block IPv6 private/local addresses
  const ipv6Patterns = [
    /^::1$/,                           // Loopback
    /^fe80:/i,                         // Link-local
    /^fc00:/i, /^fd00:/i,              // Unique local
    /^ff00:/i,                         // Multicast
    /^\[::1\]$/,                       // Bracketed loopback
    /^\[fe80:/i,                       // Bracketed link-local
    /^\[fc00:/i, /^\[fd00:/i,          // Bracketed unique local
  ];
  
  if (ipv6Patterns.some(pattern => pattern.test(hostname))) {
    throw new Error('Access to private IPv6 addresses is not allowed');
  }
  
  // Block cloud metadata endpoints via hostname
  const metadataHostnames = [
    'metadata.google.internal',
    'metadata.gcp.internal',
    'metadata',
    'instance-data',
  ];
  
  if (metadataHostnames.some(h => hostname === h || hostname.endsWith('.' + h))) {
    throw new Error('Access to cloud metadata endpoints is not allowed');
  }
  
  return parsedUrl;
}
