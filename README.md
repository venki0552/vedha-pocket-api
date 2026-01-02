# Memory Palace API (vedha-pocket-api)

A Fastify-based REST API for the Memory Palace knowledge management system. Powers the RAG pipeline for document Q&A and memory search.

## 🌟 Features

### Core Features

- 🔍 **Hybrid Search** — Vector similarity + PostgreSQL full-text search combined
- 🌊 **Streaming Responses** — Real-time SSE token streaming
- 🤖 **Multi-Query RAG** — Generates multiple search queries for better retrieval
- 🔐 **JWT Authentication** — Supabase Auth integration with RLS
- 📊 **Analytics** — Usage stats, source tracking, conversation history
- 🏢 **Multi-Tenant** — Organizations, memberships, and pocket sharing

### 🧠 Agentic RAG Pipeline (NEW!)

Advanced RAG features for production-grade question answering:

| Feature                          | Description                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Query Router**                 | Intent classification (simple lookup, comparison, summarization, analytical, follow-up) with pattern matching optimization |
| **Conversation-Aware Rewriting** | Resolves pronouns and references using conversation context                                                                |
| **Adaptive Retrieval**           | Dynamic chunk counts and weights based on query intent                                                                     |
| **CRAG (Corrective RAG)**        | Grades chunk relevance before answer generation                                                                            |
| **Self-Reflective RAG**          | Validates answer quality and retries if needed                                                                             |

### Production Hardening

- ⏱️ **Timeouts** — 10s default LLM timeout with AbortController
- 🔄 **Retry Logic** — Exponential backoff (2 retries, 500ms base)
- 🛡️ **Fallback Models** — Automatic retry with fallback LLM
- 📝 **Safe JSON Parsing** — Graceful degradation on parse failures

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your values

# Run in development
npm run dev

# Build for production
npm run build
npm start
```

## 🔧 Environment Variables

| Variable                         | Description                                       | Required |
| -------------------------------- | ------------------------------------------------- | -------- |
| `PORT`                           | API port (default: 3001)                          | No       |
| `NODE_ENV`                       | Environment (development/production)              | No       |
| `SUPABASE_URL`                   | Supabase project URL                              | Yes      |
| `SUPABASE_ANON_KEY`              | Supabase anon key                                 | Yes      |
| `SUPABASE_SERVICE_ROLE_KEY`      | Supabase service role key                         | Yes      |
| `REDIS_URL`                      | Redis connection URL                              | Yes      |
| `OPENROUTER_API_KEY`             | OpenRouter API key                                | Yes      |
| `OPENROUTER_BASE_URL`            | OpenRouter base URL                               | No       |
| `OPENROUTER_EMBED_MODEL`         | Embedding model (default: text-embedding-3-large) | No       |
| `OPENROUTER_CHAT_MODEL`          | Chat model (default: google/gemma-3-27b-it:free)  | No       |
| `OPENROUTER_FALLBACK_CHAT_MODEL` | Fallback chat model                               | No       |
| `ENCRYPTION_KEY`                 | 32-byte key for API key encryption                | Yes      |

## 📡 API Endpoints

### Authentication

All endpoints require `Authorization: Bearer <supabase_jwt>` header.

### Pockets (Document Collections)

| Method   | Path           | Description         |
| -------- | -------------- | ------------------- |
| `GET`    | `/pockets`     | List user's pockets |
| `POST`   | `/pockets`     | Create new pocket   |
| `GET`    | `/pockets/:id` | Get pocket details  |
| `PATCH`  | `/pockets/:id` | Update pocket       |
| `DELETE` | `/pockets/:id` | Delete pocket       |

### Sources (Documents)

| Method   | Path                       | Description            |
| -------- | -------------------------- | ---------------------- |
| `GET`    | `/sources`                 | List sources in pocket |
| `POST`   | `/sources/url`             | Add URL source         |
| `POST`   | `/sources/upload/init`     | Initialize file upload |
| `POST`   | `/sources/upload/complete` | Complete file upload   |
| `DELETE` | `/sources/:id`             | Delete source          |

### RAG (Question Answering)

| Method | Path          | Description                            |
| ------ | ------------- | -------------------------------------- |
| `POST` | `/search`     | Search chunks (hybrid search)          |
| `POST` | `/ask`        | RAG question answering (non-streaming) |
| `POST` | `/ask/stream` | **Agentic RAG with SSE streaming**     |

### Memories (Personal Notes)

| Method   | Path                    | Description          |
| -------- | ----------------------- | -------------------- |
| `GET`    | `/memories`             | List user's memories |
| `POST`   | `/memories`             | Create memory        |
| `PATCH`  | `/memories/:id`         | Update memory        |
| `DELETE` | `/memories/:id`         | Delete memory        |
| `POST`   | `/memories/:id/archive` | Archive memory       |

### General Chat (Memory RAG)

| Method   | Path                              | Description              |
| -------- | --------------------------------- | ------------------------ |
| `POST`   | `/general-chat/stream`            | Chat with memories (SSE) |
| `GET`    | `/general-chat/conversations`     | List conversations       |
| `DELETE` | `/general-chat/conversations/:id` | Delete conversation      |

### Other

| Method  | Path               | Description           |
| ------- | ------------------ | --------------------- |
| `GET`   | `/health`          | Health check          |
| `GET`   | `/auth/me`         | Get current user      |
| `GET`   | `/orgs`            | List organizations    |
| `GET`   | `/stats/:pocketId` | Pocket statistics     |
| `GET`   | `/analytics`       | Usage analytics       |
| `GET`   | `/settings`        | User settings         |
| `PATCH` | `/settings`        | Update settings       |
| `GET`   | `/tasks`           | Background job status |

## 🏗️ Architecture

```
src/
├── index.ts              # Fastify app entry point
├── config/
│   └── env.ts            # Environment configuration
├── middleware/
│   └── auth.ts           # JWT authentication
├── routes/
│   ├── ask-stream.ts     # Agentic RAG pipeline (main)
│   ├── general-chat.ts   # Memory RAG
│   ├── memories.ts       # Memory CRUD
│   ├── pockets.ts        # Pocket CRUD
│   ├── sources.ts        # Source management
│   └── ...
└── services/
    ├── encryption.ts     # API key encryption
    └── queue.ts          # BullMQ job queue

shared/
├── agentic/
│   └── index.ts          # Agentic RAG components
├── llm/
│   └── index.ts          # LLM providers
├── schemas/
│   └── index.ts          # Zod schemas
├── types/
│   └── index.ts          # TypeScript types
├── constants/
│   └── index.ts          # RAG constants
└── utils/
    └── index.ts          # Utility functions
```

## 🐳 Docker

```bash
# Build
docker build -t memory-palace-api .

# Run
docker run -p 3001:3001 --env-file .env memory-palace-api
```

## 📊 SSE Event Types (ask/stream)

The streaming endpoint emits these events:

| Event        | Payload                                       | Description                 |
| ------------ | --------------------------------------------- | --------------------------- |
| `status`     | `string`                                      | Progress message            |
| `routing`    | `{intent, confidence, reasoning}`             | Query intent classification |
| `rewriting`  | `{original, rewritten, entities}`             | Context-aware query rewrite |
| `queries`    | `string[]`                                    | Generated search queries    |
| `sources`    | `{source_id, title}[]`                        | Matched sources             |
| `grading`    | `{decision, avgScore, relevantCount}`         | CRAG chunk grading          |
| `token`      | `string`                                      | Answer token (streaming)    |
| `thinking`   | `string`                                      | LLM thinking tokens         |
| `reflection` | `{isGrounded, answersQuestion, overallScore}` | Answer quality grade        |
| `done`       | `{answer, citations, conversation_id}`        | Final response              |
| `error`      | `{message}`                                   | Error message               |

## 🔗 Related Repos

- **Web**: [vedha-pocket-web](https://github.com/venki0552/vedha-pocket-web)
- **Worker**: [vedha-pocket-worker](https://github.com/venki0552/vedha-pocket-worker)

## 📄 License

MIT
