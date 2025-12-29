import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { 
  createSourceUrlSchema, 
  initUploadSchema,
  listSourcesQuerySchema,
  STORAGE_BUCKET,
  SIGNED_URL_EXPIRY_SECONDS,
  MIME_TO_SOURCE_TYPE,
} from '@vedha/shared';
import { requireAuth, getUserId, getSupabaseClients } from '../middleware/auth.js';
import { enqueueIngestUrl, enqueueIngestFile } from '../services/queue.js';
import { extractTitleFromUrl } from '@vedha/shared';

export async function sourceRoutes(app: FastifyInstance) {
  // All source routes require auth
  app.addHook('preHandler', requireAuth);

  // List sources for a pocket
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    
    const query = listSourcesQuerySchema.parse(request.query);
    const { pocket_id, status, type, page, pageSize } = query;

    let dbQuery = user
      .from('sources')
      .select('*', { count: 'exact' })
      .eq('pocket_id', pocket_id)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (status) {
      dbQuery = dbQuery.eq('status', status);
    }
    if (type) {
      dbQuery = dbQuery.eq('type', type);
    }

    const { data: sources, count, error } = await dbQuery;

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch sources',
      });
    }

    return {
      data: sources,
      total: count || 0,
      page,
      pageSize,
      hasMore: (count || 0) > page * pageSize,
    };
  });

  // Get single source
  app.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user } = getSupabaseClients(request);
    const { id } = request.params;

    const { data: source, error } = await user
      .from('sources')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Source not found',
        });
      }
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to fetch source',
      });
    }

    return { data: source };
  });

  // Initialize file upload - returns signed URL
  app.post('/upload/init', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = initUploadSchema.parse(request.body);

    // Verify pocket access
    const { data: pocketMember, error: memberError } = await user
      .from('pocket_members')
      .select('org_id, role')
      .eq('pocket_id', body.pocket_id)
      .eq('user_id', userId)
      .single();

    if (memberError || !pocketMember || !['owner', 'member'].includes(pocketMember.role)) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You cannot upload to this pocket',
      });
    }

    // Generate storage path
    const storagePath = `${body.pocket_id}/${Date.now()}-${body.filename}`;

    // Create source record
    const sourceType = MIME_TO_SOURCE_TYPE[body.mime_type];
    const { data: source, error: sourceError } = await user
      .from('sources')
      .insert({
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        type: sourceType,
        title: body.filename.replace(/\.[^/.]+$/, ''), // Remove extension for title
        storage_path: storagePath,
        mime_type: body.mime_type,
        size_bytes: body.size_bytes,
        status: 'queued',
        created_by: userId,
      })
      .select()
      .single();

    if (sourceError) {
      app.log.error(sourceError);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create source record',
      });
    }

    // Generate signed upload URL
    const { data: signedUrl, error: signError } = await service.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (signError) {
      app.log.error(signError);
      // Clean up source record
      await service.from('sources').delete().eq('id', source.id);
      return reply.status(500).send({
        code: 'STORAGE_ERROR',
        message: 'Failed to generate upload URL',
      });
    }

    // Log audit event
    await service.from('audit_events').insert({
      org_id: pocketMember.org_id,
      pocket_id: body.pocket_id,
      user_id: userId,
      event_type: 'source_upload',
      metadata: { source_id: source.id, filename: body.filename },
    });

    return reply.status(201).send({
      data: {
        source,
        uploadUrl: signedUrl.signedUrl,
        token: signedUrl.token,
      },
    });
  });

  // Confirm upload completed and start pipeline
  app.post('/upload/:id/complete', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    // Get source
    const { data: source, error } = await user
      .from('sources')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !source) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Source not found',
      });
    }

    if (source.status !== 'queued') {
      return reply.status(400).send({
        code: 'INVALID_STATE',
        message: 'Source is not in queued state',
      });
    }

    // Enqueue pipeline job
    await enqueueIngestFile(
      source.id,
      source.org_id,
      source.pocket_id,
      source.storage_path!,
      source.mime_type
    );

    // Update status
    await service.from('sources').update({ status: 'extracting' }).eq('id', id);

    // Log pipeline started
    await service.from('audit_events').insert({
      org_id: source.org_id,
      pocket_id: source.pocket_id,
      user_id: userId,
      event_type: 'pipeline_started',
      metadata: { source_id: source.id },
    });

    return { data: { ...source, status: 'extracting' } };
  });

  // Save URL
  app.post('/url', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);

    const body = createSourceUrlSchema.parse(request.body);

    // Verify pocket access
    const { data: pocketMember, error: memberError } = await user
      .from('pocket_members')
      .select('org_id, role')
      .eq('pocket_id', body.pocket_id)
      .eq('user_id', userId)
      .single();

    if (memberError || !pocketMember || !['owner', 'member'].includes(pocketMember.role)) {
      return reply.status(403).send({
        code: 'FORBIDDEN',
        message: 'You cannot add sources to this pocket',
      });
    }

    // Extract title from URL if not provided
    const title = body.title || extractTitleFromUrl(body.url);

    // Create source record
    const { data: source, error: sourceError } = await user
      .from('sources')
      .insert({
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        type: 'url',
        title,
        url: body.url,
        mime_type: 'text/html',
        size_bytes: 0,
        status: 'queued',
        created_by: userId,
      })
      .select()
      .single();

    if (sourceError) {
      app.log.error(sourceError);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to create source record',
      });
    }

    // Enqueue pipeline job
    await enqueueIngestUrl(
      source.id,
      source.org_id,
      source.pocket_id,
      body.url
    );

    // Update status
    await service.from('sources').update({ status: 'extracting' }).eq('id', source.id);

    // Log audit events
    await service.from('audit_events').insert([
      {
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        user_id: userId,
        event_type: 'source_url_save',
        metadata: { source_id: source.id, url: body.url },
      },
      {
        org_id: pocketMember.org_id,
        pocket_id: body.pocket_id,
        user_id: userId,
        event_type: 'pipeline_started',
        metadata: { source_id: source.id },
      },
    ]);

    return reply.status(201).send({ data: { ...source, status: 'extracting' } });
  });

  // Reprocess source
  app.post('/:id/reprocess', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const userId = getUserId(request);
    const { id } = request.params;

    // Get source
    const { data: source, error } = await user
      .from('sources')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !source) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Source not found',
      });
    }

    // Delete existing chunks
    await service.from('chunks').delete().eq('source_id', id);

    // Reset status and enqueue
    await service.from('sources').update({ 
      status: 'queued', 
      error_message: null 
    }).eq('id', id);

    // Enqueue based on type
    if (source.type === 'url' && source.url) {
      await enqueueIngestUrl(source.id, source.org_id, source.pocket_id, source.url);
    } else if (source.storage_path) {
      await enqueueIngestFile(source.id, source.org_id, source.pocket_id, source.storage_path, source.mime_type);
    }

    // Update to extracting
    await service.from('sources').update({ status: 'extracting' }).eq('id', id);

    // Log audit event
    await service.from('audit_events').insert({
      org_id: source.org_id,
      pocket_id: source.pocket_id,
      user_id: userId,
      event_type: 'pipeline_started',
      metadata: { source_id: source.id, reprocess: true },
    });

    return { data: { ...source, status: 'extracting' } };
  });

  // Get download URL for source file
  app.get('/:id/download', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const { id } = request.params;

    // Get source
    const { data: source, error } = await user
      .from('sources')
      .select('storage_path, title')
      .eq('id', id)
      .single();

    if (error || !source || !source.storage_path) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Source not found or no file available',
      });
    }

    // Generate signed download URL
    const { data: signedUrl, error: signError } = await service.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(source.storage_path, SIGNED_URL_EXPIRY_SECONDS);

    if (signError) {
      app.log.error(signError);
      return reply.status(500).send({
        code: 'STORAGE_ERROR',
        message: 'Failed to generate download URL',
      });
    }

    return { data: { url: signedUrl.signedUrl, expiresIn: SIGNED_URL_EXPIRY_SECONDS } };
  });

  // Delete source
  app.delete('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { user, service } = getSupabaseClients(request);
    const { id } = request.params;

    // Get source for storage path
    const { data: source, error: fetchError } = await user
      .from('sources')
      .select('storage_path')
      .eq('id', id)
      .single();

    if (fetchError) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Source not found',
      });
    }

    // Delete from storage if applicable
    if (source.storage_path) {
      await service.storage.from(STORAGE_BUCKET).remove([source.storage_path]);
    }

    // Delete source (chunks will cascade delete)
    const { error } = await user.from('sources').delete().eq('id', id);

    if (error) {
      app.log.error(error);
      return reply.status(500).send({
        code: 'DATABASE_ERROR',
        message: 'Failed to delete source',
      });
    }

    return reply.status(204).send();
  });
}
