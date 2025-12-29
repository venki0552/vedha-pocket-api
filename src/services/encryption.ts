import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Encrypt a string using AES-256-GCM
 */
export function encrypt(text: string): string {
  if (!env.MASTER_KEY) {
    throw new Error('MASTER_KEY not configured');
  }

  const key = Buffer.from(env.MASTER_KEY.slice(0, 32).padEnd(32, '0'), 'utf-8');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  // Return IV + Tag + Encrypted data as hex
  return iv.toString('hex') + tag.toString('hex') + encrypted;
}

/**
 * Decrypt a string encrypted with encrypt()
 */
export function decrypt(encryptedText: string): string {
  if (!env.MASTER_KEY) {
    throw new Error('MASTER_KEY not configured');
  }

  const key = Buffer.from(env.MASTER_KEY.slice(0, 32).padEnd(32, '0'), 'utf-8');

  // Extract IV, Tag, and encrypted data
  const iv = Buffer.from(encryptedText.slice(0, IV_LENGTH * 2), 'hex');
  const tag = Buffer.from(encryptedText.slice(IV_LENGTH * 2, (IV_LENGTH + TAG_LENGTH) * 2), 'hex');
  const encrypted = encryptedText.slice((IV_LENGTH + TAG_LENGTH) * 2);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
