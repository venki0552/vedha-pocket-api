import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { updateSettingsSchema } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { encrypt } from '../services/encryption.js';
import { env } from '../config/env.js';

export async function settingsRoutes(app: FastifyInstance) {
  // All settings routes require auth
  app.addHook('preHandler', requireAuth);

  // Get user settings
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);

    const { data: settings, error } = await user
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch settings',
      });
    }

    // Don't return the encrypted key, just whether it's set
    return {
      data: {
        user_id: userId,
        org_id_default: settings?.org_id_default || null,
        has_openrouter_key: !!settings?.openrouter_api_key_encrypted,
        created_at: settings?.created_at,
        updated_at: settings?.updated_at,
      },
    };
  });

  // Update user settings
  app.patch('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = updateSettingsSchema.parse(request.body);

    // Prepare update payload
    const updatePayload: Record<string, unknown> = {};

    if (body.org_id_default !== undefined) {
      updatePayload.org_id_default = body.org_id_default;
    }

    if (body.openrouter_api_key !== undefined) {
      if (body.openrouter_api_key && env.MASTER_KEY) {
        updatePayload.openrouter_api_key_encrypted = encrypt(body.openrouter_api_key);
      } else if (!body.openrouter_api_key) {
        updatePayload.openrouter_api_key_encrypted = null;
      }
    }

    // Upsert settings
    const { data: settings, error } = await user
      .from('user_settings')
      .upsert({
        user_id: userId,
        ...updatePayload,
      })
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to update settings',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: settings.org_id_default || '00000000-0000-0000-0000-000000000000',
      user_id: userId,
      event_type: 'settings_update',
      metadata: { 
        updated_fields: Object.keys(updatePayload),
        has_openrouter_key: !!updatePayload.openrouter_api_key_encrypted,
      },
    });

    return {
      data: {
        user_id: userId,
        org_id_default: settings.org_id_default,
        has_openrouter_key: !!settings.openrouter_api_key_encrypted,
        created_at: settings.created_at,
        updated_at: settings.updated_at,
      },
    };
  });

  // Store OpenRouter API key
  app.post('/openrouter-key', async (request: FastifyRequest<{ Body: { api_key: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const { api_key } = request.body as { api_key?: string };

    if (!api_key) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'api_key is required',
      });
    }

    if (!env.MASTER_KEY) {
      return reply.status(500).send({
        code: 'CONFIG_ERROR',
        message: 'API key storage is not configured',
      });
    }

    // Validate the key by making a test request
    try {
      const testResponse = await fetch(`${env.OPENROUTER_BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${api_key}`,
        },
      });

      if (!testResponse.ok) {
        return reply.status(400).send({
          code: 'INVALID_KEY',
          message: 'The provided API key is invalid',
        });
      }
    } catch {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Could not validate API key',
      });
    }

    // Encrypt and store
    const encrypted = encrypt(api_key);

    const { error } = await user
      .from('user_settings')
      .upsert({
        user_id: userId,
        openrouter_api_key_encrypted: encrypted,
      });

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to store API key',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: '00000000-0000-0000-0000-000000000000',
      user_id: userId,
      event_type: 'settings_update',
      metadata: { action: 'openrouter_key_set' },
    });

    return { data: { success: true } };
  });

  // Delete OpenRouter API key
  app.delete('/openrouter-key', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const { error } = await user
      .from('user_settings')
      .update({ openrouter_api_key_encrypted: null })
      .eq('user_id', userId);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete API key',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: '00000000-0000-0000-0000-000000000000',
      user_id: userId,
      event_type: 'settings_update',
      metadata: { action: 'openrouter_key_deleted' },
    });

    return { data: { success: true } };
  });
}
