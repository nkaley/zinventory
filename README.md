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

## Single-active-user lock

Only one user can work with the application at any given time.

- On page load, the frontend gets/creates a local `session_id` (UUID) and acquires a
  global lock via `POST /session/acquire`.
- Every API request goes through a middleware that requires the `X-Session-Id`
  header. If the active lock belongs to a different user, the server responds with
  `423 Locked` and the frontend shows a "Session busy" screen and retries
  automatically.
- Lock TTL is 60 seconds. The frontend keeps the lock alive with a heartbeat every
  20 seconds and tries to release it via `POST /session/release` when the tab is
  closed. If the tab/process disappears without a clean exit, the lock is released
  automatically once the TTL expires.
- Idle timeout: if the user shows no activity (mouse/keyboard/scroll/click) for more
  than 10 minutes, the frontend releases the lock itself and shows a "Session ended"
  screen. The user can return via the "Log in again" button.
- The "Log out" button in the header releases the lock immediately and shows a
  "You have logged out" screen.

Paths available without `X-Session-Id`: `/health`, `/session/*`, `/docs`, `/redoc`,
`/openapi.json`.
