import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createOrgSchema } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';

export async function orgRoutes(app: FastifyInstance) {
  // All org routes require auth
  app.addHook('preHandler', requireAuth);

  // List user's orgs
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const userId = getUserId(request);

    const { data: orgs, error } = await user
      .from('orgs')
      .select(`
        *,
        memberships!inner(role)
      `)
      .eq('memberships.user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch organizations',
      });
    }

    return { data: orgs };
  });

  // Create org
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = createOrgSchema.parse(request.body);

    // Insert org
    const { data: org, error } = await user
      .from('orgs')
      .insert({
        name: body.name,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create organization',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: org.id,
      user_id: userId,
      event_type: 'pocket_create', // We'll use this for org create too
      metadata: { org_name: body.name },
    });

    return reply.status(201).send({ data: org });
  });

  // Get single org
  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;

    const { data: org, error } = await user
      .from('orgs')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch organization',
      });
    }

    return { data: org };
  });
}
