import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createTaskSchema, updateTaskSchema, listTasksQuerySchema } from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';

export async function taskRoutes(app: FastifyInstance) {
  // All task routes require auth
  app.addHook('preHandler', requireAuth);

  // List tasks
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const _userId = getUserId(request);

    const query = listTasksQuerySchema.parse(request.query);
    const { pocket_id, status, priority, overdue, assignee_user_id, page, pageSize } = query;

    let dbQuery = user
      .from('tasks')
      .select('*, pockets(name)', { count: 'exact' })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('priority', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (pocket_id) {
      dbQuery = dbQuery.eq('pocket_id', pocket_id);
    }
    if (status) {
      dbQuery = dbQuery.eq('status', status);
    }
    if (priority) {
      dbQuery = dbQuery.eq('priority', priority);
    }
    if (assignee_user_id) {
      dbQuery = dbQuery.eq('assignee_user_id', assignee_user_id);
    }
    if (overdue) {
      dbQuery = dbQuery.lt('due_at', new Date().toISOString());
      dbQuery = dbQuery.neq('status', 'done');
    }

    const { data: tasks, count, error } = await dbQuery;

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch tasks',
      });
    }

    return {
      data: tasks,
      total: count || 0,
      page,
      pageSize,
      hasMore: (count || 0) > page * pageSize,
    };
  });

  // Get single task
  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;

    const { data: task, error } = await user
      .from('tasks')
      .select('*, pockets(name)')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch task',
      });
    }

    return { data: task };
  });

  // Create task
  app.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = createTaskSchema.parse(request.body);

    // Verify pocket access
    const { data: pocketMember, error: memberError } = await user
      .from('pocket_members')
      .select('org_id')
      .eq('pocket_id', body.pocket_id)
      .eq('user_id', userId)
      .single();

    if (memberError || !pocketMember) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You do not have access to this pocket',
      });
    }

    // Create task
    const { data: task, error } = await user
      .from('tasks')
      .insert({
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        title: body.title,
        description: body.description,
        due_at: body.due_at,
        priority: body.priority,
        assignee_user_id: body.assignee_user_id,
        linked_chunk_ids: body.linked_chunk_ids,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create task',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: pocketMember.org_id,
      pocket_id: body.pocket_id,
      user_id: userId,
      event_type: 'task_create',
      metadata: { task_id: task.id, title: body.title },
    });

    return reply.status(201).send({ data: task });
  });

  // Update task
  app.patch('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    const body = updateTaskSchema.parse(request.body);

    // Get existing task for audit log
    const { data: existing, error: fetchError } = await user
      .from('tasks')
      .select('org_id, pocket_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Task not found',
      });
    }

    // Update task
    const { data: task, error } = await user
      .from('tasks')
      .update({
        title: body.title,
        description: body.description,
        due_at: body.due_at,
        priority: body.priority,
        status: body.status,
        assignee_user_id: body.assignee_user_id,
        linked_chunk_ids: body.linked_chunk_ids,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to update task',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: existing.org_id,
      pocket_id: existing.pocket_id,
      user_id: userId,
      event_type: 'task_update',
      metadata: { task_id: id, changes: body },
    });

    return { data: task };
  });

  // Delete task
  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;

    const { error } = await user
      .from('tasks')
      .delete()
      .eq('id', id);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete task',
      });
    }

    return reply.status(204).send();
  });
}
