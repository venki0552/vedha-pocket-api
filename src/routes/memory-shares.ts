import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';

// Validation schemas
const shareMemorySchema = z.object({
  memory_ids: z.array(z.string().uuid()).min(1),
  email: z.string().email(),
  permission: z.enum(['view', 'comment']).default('view'),
});

const updateShareSchema = z.object({
  permission: z.enum(['view', 'comment']),
});

export async function memoryShareRoutes(app: FastifyInstance) {
  // All share routes require auth
  app.addHook('preHandler', requireAuth);

  // Get shares for a memory
  app.get('/memory/:memoryId', async (request: FastifyRequest<{ Params: { memoryId: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { memoryId } = request.params;

    // Verify ownership
    const { data: memory, error: memoryError } = await user
      .from('memories')
      .select('id')
      .eq('id', memoryId)
      .eq('user_id', userId)
      .single();

    if (memoryError || !memory) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Memory not found',
      });
    }

    // Get shares
    const { data: shares, error } = await user
      .from('memory_shares')
      .select('*')
      .eq('memory_id', memoryId);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch shares',
      });
    }

    return { data: shares };
  });

  // Share memories (single or multiple)
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = shareMemorySchema.parse(request.body);

    // Verify ownership of all memories
    const { data: memories, error: memoryError } = await user
      .from('memories')
      .select('id')
      .in('id', body.memory_ids)
      .eq('user_id', userId);

    if (memoryError || !memories || memories.length !== body.memory_ids.length) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You can only share your own memories',
      });
    }

    // Check if user exists in the system
    const { data: existingUser, error: userError } = await service
      .from('user_settings')
      .select('user_id')
      .eq('user_id', (
        await service.auth.admin.getUserByEmail(body.email)
      ).data?.user?.id || 'no-user')
      .single();

    // Look up user by email using admin API
    const { data: userData } = await service.auth.admin.getUserByEmail(body.email);
    const sharedWithUserId = userData?.user?.id || null;

    // Create shares for each memory
    const shares = body.memory_ids.map(memoryId => ({
      memory_id: memoryId,
      shared_with_user_id: sharedWithUserId,
      shared_with_email: sharedWithUserId ? null : body.email, // Only store email if no user account
      permission: body.permission,
      shared_by_user_id: userId,
    }));

    // Remove existing shares for same email/user on these memories to avoid duplicates
    if (sharedWithUserId) {
      await user
        .from('memory_shares')
        .delete()
        .in('memory_id', body.memory_ids)
        .eq('shared_with_user_id', sharedWithUserId);
    } else {
      await user
        .from('memory_shares')
        .delete()
        .in('memory_id', body.memory_ids)
        .eq('shared_with_email', body.email);
    }

    // Insert new shares
    const { data: createdShares, error } = await user
      .from('memory_shares')
      .insert(shares)
      .select();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create shares',
      });
    }

    // TODO: Send email notification if user doesn't have an account
    // For now, we just return the share with its token
    const response = {
      shares: createdShares,
      user_exists: !!sharedWithUserId,
      email: body.email,
    };

    return reply.status(201).send({ data: response });
  });

  // Update share permission
  app.patch('/:shareId', async (request: FastifyRequest<{ Params: { shareId: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { shareId } = request.params;

    const body = updateShareSchema.parse(request.body);

    const { data: share, error } = await user
      .from('memory_shares')
      .update({ permission: body.permission })
      .eq('id', shareId)
      .eq('shared_by_user_id', userId)
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to update share',
      });
    }

    if (!share) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Share not found',
      });
    }

    return { data: share };
  });

  // Remove share
  app.delete('/:shareId', async (request: FastifyRequest<{ Params: { shareId: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { shareId } = request.params;

    const { error } = await user
      .from('memory_shares')
      .delete()
      .eq('id', shareId)
      .eq('shared_by_user_id', userId);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete share',
      });
    }

    return reply.status(204).send();
  });

  // Get share by token (for email link access)
  app.get('/token/:token', async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const { service } = getSupabaseClients(request);
    const { token } = request.params;

    const { data: share, error } = await service
      .from('memory_shares')
      .select(`
        *,
        memories (*)
      `)
      .eq('share_token', token)
      .single();

    if (error || !share) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Share not found or expired',
      });
    }

    return { data: share };
  });
}
