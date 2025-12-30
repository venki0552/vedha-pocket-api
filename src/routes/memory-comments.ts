import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';

// Validation schemas
const createCommentSchema = z.object({
  memory_id: z.string().uuid(),
  content: z.string().min(1).max(5000),
  position_start: z.number().int().optional(),
  position_end: z.number().int().optional(),
  parent_comment_id: z.string().uuid().optional(),
});

const updateCommentSchema = z.object({
  content: z.string().min(1).max(5000),
});

export async function memoryCommentRoutes(app: FastifyInstance) {
  // All comment routes require auth
  app.addHook('preHandler', requireAuth);

  // Get comments for a memory
  app.get('/memory/:memoryId', async (request: FastifyRequest<{ Params: { memoryId: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { memoryId } = request.params;

    // Check if user has access to this memory (owner or shared)
    const { data: memory } = await user
      .from('memories')
      .select('id')
      .eq('id', memoryId)
      .single();

    if (!memory) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Memory not found or you do not have access',
      });
    }

    // Get comments with user info
    const { data: comments, error } = await service
      .from('memory_comments')
      .select(`
        id,
        content,
        position_start,
        position_end,
        parent_comment_id,
        created_at,
        updated_at,
        user_id
      `)
      .eq('memory_id', memoryId)
      .order('created_at', { ascending: true });

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch comments',
      });
    }

    // Get user emails for comments
    const userIds = [...new Set(comments?.map((c: { user_id: string }) => c.user_id) || [])];
    const { data: users } = await service.auth.admin.listUsers();
    const userMap = new Map(users?.users?.map((u: { id: string; email?: string }) => [u.id, u.email]) || []);

    const commentsWithUsers = comments?.map((c: { user_id: string; id: string; content: string; position_data: any; parent_comment_id: string | null; created_at: string; updated_at: string }) => ({
      ...c,
      user_email: userMap.get(c.user_id) || 'Unknown',
      is_own: c.user_id === userId,
    }));

    return { data: commentsWithUsers };
  });

  // Create comment
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = createCommentSchema.parse(request.body);

    // Check if user has access to this memory (owner or shared with comment permission)
    const { data: memory } = await user
      .from('memories')
      .select('id, user_id')
      .eq('id', body.memory_id)
      .single();

    if (!memory) {
      // Check if shared with comment permission
      const { data: share } = await user
        .from('memory_shares')
        .select('id')
        .eq('memory_id', body.memory_id)
        .eq('shared_with_user_id', userId)
        .eq('permission', 'comment')
        .single();

      if (!share) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'You do not have permission to comment on this memory',
        });
      }
    }

    // Insert comment
    const { data: comment, error } = await user
      .from('memory_comments')
      .insert({
        memory_id: body.memory_id,
        user_id: userId,
        content: body.content,
        position_start: body.position_start,
        position_end: body.position_end,
        parent_comment_id: body.parent_comment_id,
      })
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create comment',
      });
    }

    return reply.status(201).send({ data: comment });
  });

  // Update comment
  app.patch('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    const body = updateCommentSchema.parse(request.body);

    const { data: comment, error } = await user
      .from('memory_comments')
      .update({ content: body.content })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to update comment',
      });
    }

    if (!comment) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Comment not found',
      });
    }

    return { data: comment };
  });

  // Delete comment
  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    // User can delete their own comment, or memory owner can delete any comment
    const { data: comment, error: fetchError } = await user
      .from('memory_comments')
      .select('id, user_id, memory_id')
      .eq('id', id)
      .single();

    if (fetchError || !comment) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Comment not found',
      });
    }

    // Check if user owns the comment or the memory
    const canDelete = comment.user_id === userId;
    
    if (!canDelete) {
      // Check if user owns the memory
      const { data: memory } = await user
        .from('memories')
        .select('id')
        .eq('id', comment.memory_id)
        .eq('user_id', userId)
        .single();

      if (!memory) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'You can only delete your own comments',
        });
      }
    }

    const { error } = await user
      .from('memory_comments')
      .delete()
      .eq('id', id);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete comment',
      });
    }

    return reply.status(204).send();
  });
}
