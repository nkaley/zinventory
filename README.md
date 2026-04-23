# Zinventory

`docker-compose.yml` starts 3 containers: `db` (Postgres), `backend` (FastAPI), and `frontend` (Next.js).

## Prerequisites

- Docker
- Docker Compose

## Quick Start

1. Create your local env file:
   - `cp .env.example .env`
2. Edit `.env` (especially `ZOHO_*` values).
3. Run:
   - `docker compose up --build`
4. Open:
   - Frontend: `http://localhost:3000`
   - Backend: `http://localhost:8000/docs`
