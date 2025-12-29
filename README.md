# Vedha Pocket API

A Fastify-based REST API for the Vedha Pocket knowledge management system.

## Features

- 🔍 Hybrid search (vector + full-text)
- 🌊 Streaming responses (SSE)
- 🤖 Multi-query RAG for better retrieval
- 🔐 JWT authentication via Supabase
- 📊 Analytics and usage stats

## Quick Start

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

## Environment Variables

| Variable                    | Description               | Required |
| --------------------------- | ------------------------- | -------- |
| `PORT`                      | API port (default: 3001)  | No       |
| `SUPABASE_URL`              | Supabase project URL      | Yes      |
| `SUPABASE_ANON_KEY`         | Supabase anon key         | Yes      |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Yes      |
| `REDIS_URL`                 | Redis connection URL      | Yes      |
| `OPENROUTER_API_KEY`        | OpenRouter API key        | Yes      |
| `OPENROUTER_BASE_URL`       | OpenRouter base URL       | No       |
| `OPENROUTER_EMBED_MODEL`    | Embedding model           | No       |
| `OPENROUTER_CHAT_MODEL`     | Chat model                | No       |
| `LLM_BASE_URL`              | Local LLM URL (Ollama)    | No       |

## API Endpoints

### Authentication

All endpoints require `Authorization: Bearer <token>` header.

### Routes

| Method | Path                   | Description            |
| ------ | ---------------------- | ---------------------- |
| `GET`  | `/health`              | Health check           |
| `GET`  | `/auth/me`             | Get current user       |
| `GET`  | `/orgs`                | List organizations     |
| `GET`  | `/pockets`             | List pockets           |
| `POST` | `/pockets`             | Create pocket          |
| `GET`  | `/sources`             | List sources           |
| `POST` | `/sources/url`         | Add URL source         |
| `POST` | `/sources/upload/init` | Init file upload       |
| `POST` | `/search`              | Search chunks          |
| `POST` | `/ask`                 | RAG question answering |
| `POST` | `/ask/stream`          | Streaming RAG (SSE)    |
| `GET`  | `/stats/:pocketId`     | Get pocket stats       |

## Docker

```bash
docker build -t vedha-pocket-api .
docker run -p 3001:3001 --env-file .env vedha-pocket-api
```

## License

MIT
