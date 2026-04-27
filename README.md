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

Только один пользователь может одновременно работать с приложением.

- При открытии страницы фронтенд получает/создает локальный `session_id` (UUID) и
  захватывает глобальный lock через `POST /session/acquire`.
- Любой запрос к API проходит через middleware, которое требует заголовок
  `X-Session-Id`. Если активный lock принадлежит другому пользователю — сервер
  отвечает `423 Locked`, и фронтенд показывает экран «Система занята» с
  автоматическим повтором.
- TTL блокировки — 60 секунд. Фронтенд продлевает lock heartbeat-ом раз в 20 секунд
  и сам пытается отпустить его через `POST /session/release` при закрытии вкладки.
  Если вкладка/процесс пропадают без штатного выхода, lock освобождается автоматически
  через TTL.

Пути, доступные без `X-Session-Id`: `/health`, `/session/*`, `/docs`, `/redoc`,
`/openapi.json`.
