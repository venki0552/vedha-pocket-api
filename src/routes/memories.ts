import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { getQueue } from '../services/queue.js';

// Validation schemas
const createMemorySchema = z.object({
  org_id: z.string().uuid(),
  title: z.string().optional(),
  content: z.string().default(''),
  content_html: z.string().default(''),
  color: z.enum(['default', 'coral', 'peach', 'sand', 'mint', 'sage', 'fog', 'storm', 'dusk', 'blossom', 'clay', 'chalk']).default('default'),
  tags: z.array(z.string()).default([]),
  is_pinned: z.boolean().default(false),
});

const updateMemorySchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  content_html: z.string().optional(),
  color: z.enum(['default', 'coral', 'peach', 'sand', 'mint', 'sage', 'fog', 'storm', 'dusk', 'blossom', 'clay', 'chalk']).optional(),
  tags: z.array(z.string()).optional(),
  is_pinned: z.boolean().optional(),
  is_archived: z.boolean().optional(),
});

export async function memoryRoutes(app: FastifyInstance) {
  // All memory routes require auth
  app.addHook('preHandler', requireAuth);

  // List user's memories
  app.get('/', async (request: FastifyRequest<{ 
    Querystring: { 
      org_id?: string;
      status?: 'draft' | 'published' | 'all';
      archived?: string;
      tag?: string;
      color?: string;
    } 
  }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { org_id, status = 'all', archived = 'false', tag, color } = request.query;

    let query = user
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .order('is_pinned', { ascending: false })
      .order('updated_at', { ascending: false });

    if (org_id) {
      query = query.eq('org_id', org_id);
    }

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    if (archived === 'false') {
      query = query.eq('is_archived', false);
    } else if (archived === 'true') {
      query = query.eq('is_archived', true);
    }

    if (tag) {
      query = query.contains('tags', [tag]);
    }

    if (color) {
      query = query.eq('color', color);
    }

    const { data: memories, error } = await query;

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch memories',
      });
    }

    return { data: memories };
  });

  // Get all unique tags for user
  app.get('/tags', async (request: FastifyRequest<{ Querystring: { org_id?: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { org_id } = request.query;

    let query = user
      .from('memories')
      .select('tags')
      .eq('user_id', userId)
      .eq('is_archived', false);

    if (org_id) {
      query = query.eq('org_id', org_id);
    }

    const { data: memories, error } = await query;

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch tags',
      });
    }

    // Extract unique tags
    const allTags = memories?.flatMap((m: { tags?: string[] }) => m.tags || []) || [];
    const uniqueTags = [...new Set(allTags)].sort();

    return { data: uniqueTags };
  });

  // Create memory
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = createMemorySchema.parse(request.body);

    // Verify user is member of org
    const { data: membership, error: membershipError } = await user
      .from('memberships')
      .select('id')
      .eq('org_id', body.org_id)
      .eq('user_id', userId)
      .single();

    if (membershipError || !membership) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You are not a member of this organization',
      });
    }

    // Insert memory
    const { data: memory, error } = await user
      .from('memories')
      .insert({
        org_id: body.org_id,
        user_id: userId,
        title: body.title,
        content: body.content,
        content_html: body.content_html,
        color: body.color,
        tags: body.tags,
        is_pinned: body.is_pinned,
      })
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create memory',
      });
    }

    return reply.status(201).send({ data: memory });
  });

  // Get single memory
  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;

    const { data: memory, error } = await user
      .from('memories')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !memory) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Memory not found',
      });
    }

    return { data: memory };
  });

  // Update memory
  app.patch('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    const body = updateMemorySchema.parse(request.body);

    // Update memory
    const { data: memory, error } = await user
      .from('memories')
      .update(body)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to update memory',
      });
    }

    if (!memory) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Memory not found',
      });
    }

    return { data: memory };
  });

  // Publish memory (chunk and embed for RAG)
  app.post('/:id/publish', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    // Get memory
    const { data: memory, error: fetchError } = await user
      .from('memories')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchError || !memory) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Memory not found',
      });
    }

    if (memory.status === 'published') {
      return reply.status(400).send({
        code: 'ALREADY_PUBLISHED',
        message: 'Memory is already published',
      });
    }

    // Update status to published
    const { data: updatedMemory, error: updateError } = await user
      .from('memories')
      .update({ 
        status: 'published',
        published_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      app.log.error(updateError);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to publish memory',
      });
    }

    // Queue the memory for chunking and embedding
    try {
      const queue = getQueue();
      await queue.add('chunk-memory', {
        memoryId: id,
        orgId: memory.org_id,
        userId: userId,
      }, {
        priority: 1,
      });
    } catch (queueError) {
      app.log.error(queueError, 'Failed to queue memory for processing');
      // Don't fail - memory is published, just needs embedding later
    }

    return { data: updatedMemory };
  });

  // Unpublish memory (remove from search)
  app.post('/:id/unpublish', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    // Update status to draft and delete chunks
    const { data: memory, error: updateError } = await user
      .from('memories')
      .update({ 
        status: 'draft',
        published_at: null,
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (updateError) {
      app.log.error(updateError);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to unpublish memory',
      });
    }

    if (!memory) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Memory not found',
      });
    }

    // Delete chunks (using service role for RLS bypass)
    await service
      .from('memory_chunks')
      .delete()
      .eq('memory_id', id);

    return { data: memory };
  });

  // Delete memory
  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    const { error } = await user
      .from('memories')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete memory',
      });
    }

    return reply.status(204).send();
  });

  // Get memories shared with me
  app.get('/shared/with-me', async (request: FastifyRequest<{ Querystring: { org_id?: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);

    const { data: shares, error } = await user
      .from('memory_shares')
      .select(`
        id,
        permission,
        created_at,
        memories (
          id,
          title,
          content,
          color,
          tags,
          status,
          updated_at
        ),
        shared_by:shared_by_user_id (
          id,
          email
        )
      `)
      .eq('shared_with_user_id', userId);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch shared memories',
      });
    }

    return { data: shares };
  });
}
