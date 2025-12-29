import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createPocketSchema, inviteToPocketSchema } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';

export async function pocketRoutes(app: FastifyInstance) {
  // All pocket routes require auth
  app.addHook('preHandler', requireAuth);

  // List user's pockets
  app.get('/', async (request: FastifyRequest<{ Querystring: { org_id?: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { org_id } = request.query;

    let query = user
      .from('pockets')
      .select(`
        *,
        pocket_members!inner(role),
        sources(count)
      `)
      .eq('pocket_members.user_id', userId)
      .order('created_at', { ascending: false });

    if (org_id) {
      query = query.eq('org_id', org_id);
    }

    const { data: pockets, error } = await query;

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch pockets',
      });
    }

    return { data: pockets };
  });

  // Create pocket
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = createPocketSchema.parse(request.body);

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

    // Insert pocket
    const { data: pocket, error } = await user
      .from('pockets')
      .insert({
        org_id: body.org_id,
        name: body.name,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create pocket',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: body.org_id,
      pocket_id: pocket.id,
      user_id: userId,
      event_type: 'pocket_create',
      metadata: { pocket_name: body.name },
    });

    return reply.status(201).send({ data: pocket });
  });

  // Get single pocket
  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;

    const { data: pocket, error } = await user
      .from('pockets')
      .select(`
        *,
        pocket_members(user_id, role)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Pocket not found',
        });
      }
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch pocket',
      });
    }

    return { data: pocket };
  });

  // Update pocket
  app.patch('/:id', async (request: FastifyRequest<{ Params: { id: string }; Body: { name: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;
    const { name } = request.body as { name?: string };

    if (!name) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Name is required',
      });
    }

    const { data: pocket, error } = await user
      .from('pockets')
      .update({ name })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to update pocket',
      });
    }

    return { data: pocket };
  });

  // Delete pocket
  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;

    const { error } = await user
      .from('pockets')
      .delete()
      .eq('id', id);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete pocket',
      });
    }

    return reply.status(204).send();
  });

  // Invite user to pocket
  app.post('/:id/invite', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const _userId = getUserId(request);
    const { id } = request.params;

    const body = inviteToPocketSchema.parse(request.body);

    // Get pocket with org_id
    const { data: pocket, error: pocketError } = await user
      .from('pockets')
      .select('org_id')
      .eq('id', id)
      .single();

    if (pocketError || !pocket) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Pocket not found',
      });
    }

    // Find user by email
    // Note: This query won't work as auth.users isn't exposed via data API
    // Keeping the code for documentation purposes
    const _lookupResult = await service
      .from('auth.users')
      .select('id')
      .eq('email', body.email)
      .limit(1);

    // Supabase doesn't expose auth.users directly, use a different approach
    // For now, we'll need the user to exist first - in a real app you'd send an invite email
    
    return reply.status(501).send({
      code: 'NOT_IMPLEMENTED',
      message: 'Email invites not yet implemented - user must sign up first',
    });
  });
}
