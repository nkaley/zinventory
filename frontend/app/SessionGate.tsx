"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const SESSION_STORAGE_KEY = "zinventory_session_id";
const HEARTBEAT_INTERVAL_MS = 20_000;
const RETRY_INTERVAL_MS = 5_000;

type GateStatus = "loading" | "ok" | "blocked" | "error";

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && existing.length >= 8) return existing;
    const fresh = generateSessionId();
    window.localStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // localStorage unavailable; fall back to in-memory id (won't survive reload)
    return generateSessionId();
  }
}

function resolveUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export default function SessionGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<GateStatus>("loading");
  const sessionIdRef = useRef<string>("");
  const heartbeatTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const acquireInFlightRef = useRef<boolean>(false);

  // Initialize session id and patch fetch as soon as possible on the client.
  useEffect(() => {
    if (typeof window === "undefined") return;

    sessionIdRef.current = getOrCreateSessionId();

    const originalFetch = window.fetch.bind(window);

    const patchedFetch: typeof window.fetch = (input, init) => {
      try {
        const url = resolveUrlString(input);
        if (url.startsWith(API_BASE)) {
          const baseHeaders =
            init?.headers ??
            (typeof input !== "string" && !(input instanceof URL)
              ? (input as Request).headers
              : undefined);
          const headers = new Headers(baseHeaders ?? undefined);
          if (!headers.has("X-Session-Id") && sessionIdRef.current) {
            headers.set("X-Session-Id", sessionIdRef.current);
          }
          return originalFetch(input, { ...(init ?? {}), headers });
        }
      } catch {
        // Fall through to original fetch on any header-handling failure.
      }
      return originalFetch(input, init);
    };

    window.fetch = patchedFetch;

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  // Acquire the lock on mount and keep it alive with heartbeats.
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    function clearRetry(): void {
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    }

    function clearHeartbeat(): void {
      if (heartbeatTimerRef.current != null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    }

    function scheduleRetry(): void {
      clearRetry();
      retryTimerRef.current = window.setTimeout(() => {
        void acquire();
      }, RETRY_INTERVAL_MS);
    }

    async function acquire(): Promise<void> {
      if (cancelled) return;
      if (acquireInFlightRef.current) return;
      acquireInFlightRef.current = true;
      try {
        const response = await fetch(`${API_BASE}/session/acquire`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        });

        if (cancelled) return;

        if (response.status === 423) {
          setStatus("blocked");
          scheduleRetry();
          return;
        }

        if (!response.ok) {
          setStatus("error");
          scheduleRetry();
          return;
        }

        setStatus("ok");
        clearRetry();
        if (heartbeatTimerRef.current == null) {
          heartbeatTimerRef.current = window.setInterval(() => {
            void heartbeat();
          }, HEARTBEAT_INTERVAL_MS);
        }
      } catch {
        if (cancelled) return;
        setStatus("error");
        scheduleRetry();
      } finally {
        acquireInFlightRef.current = false;
      }
    }

    async function heartbeat(): Promise<void> {
      try {
        const response = await fetch(`${API_BASE}/session/acquire`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        });

        if (response.status === 423) {
          setStatus("blocked");
          clearHeartbeat();
          scheduleRetry();
        }
      } catch {
        // Network blip during heartbeat is fine — the next one will retry.
      }
    }

    void acquire();

    return () => {
      cancelled = true;
      clearRetry();
      clearHeartbeat();
    };
  }, []);

  // Best-effort release when the tab is closed or hidden.
  useEffect(() => {
    if (typeof window === "undefined") return;

    function release(): void {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      const url = `${API_BASE}/session/release`;
      const body = JSON.stringify({ session_id: sessionId });

      try {
        if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
          const blob = new Blob([body], { type: "application/json" });
          const sent = navigator.sendBeacon(url, blob);
          if (sent) return;
        }
      } catch {
        // fall through to keepalive fetch
      }

      try {
        void fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Id": sessionId,
          },
          body,
          keepalive: true,
        });
      } catch {
        // ignore — best-effort only; the lock will expire via TTL anyway
      }
    }

    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);

    return () => {
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
    };
  }, []);

  if (status === "ok") {
    return <>{children}</>;
  }

  return (
    <div className="modalOverlay" role="alertdialog" aria-modal="true" aria-live="polite">
      <div className="modalCard">
        {status === "loading" ? (
          <>
            <h3 className="modalTitle">Подключение...</h3>
            <p className="modalText">Проверяем доступность системы.</p>
            <div className="syncProgress">
              <span className="spinner" aria-hidden="true" />
              <span>Подождите немного</span>
            </div>
          </>
        ) : null}

        {status === "blocked" ? (
          <>
            <h3 className="modalTitle">Система занята</h3>
            <p className="modalText">
              Сейчас в системе работает другой пользователь. С приложением одновременно может работать
              только один человек. Попробуем подключиться повторно автоматически.
            </p>
            <div className="syncProgress">
              <span className="spinner" aria-hidden="true" />
              <span>Ожидаем освобождения</span>
            </div>
          </>
        ) : null}

        {status === "error" ? (
          <>
            <h3 className="modalTitle">Нет связи с сервером</h3>
            <p className="modalText">
              Не удается подключиться к серверу. Повторим попытку через несколько секунд.
            </p>
            <div className="syncProgress">
              <span className="spinner" aria-hidden="true" />
              <span>Повторное подключение</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
