"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const SESSION_STORAGE_KEY = "zinventory_session_id";
const HEARTBEAT_INTERVAL_MS = 20_000;
const RETRY_INTERVAL_MS = 5_000;
const IDLE_LIMIT_MS = 10 * 60 * 1000;

type GateStatus = "loading" | "ok" | "blocked" | "error" | "idle" | "logged_out";

type SessionContextValue = {
  logout: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within <SessionGate>");
  }
  return ctx;
}

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
  const lastActivityRef = useRef<number>(Date.now());

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current != null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current != null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const releaseLockRequest = useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      await fetch(`${API_BASE}/session/release`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": sessionId,
        },
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch {
      // The lock will eventually expire by TTL anyway.
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current != null) return;
    heartbeatTimerRef.current = window.setInterval(() => {
      void heartbeatTick();
    }, HEARTBEAT_INTERVAL_MS);

    async function heartbeatTick(): Promise<void> {
      if (Date.now() - lastActivityRef.current > IDLE_LIMIT_MS) {
        clearHeartbeat();
        clearRetry();
        await releaseLockRequest();
        setStatus("idle");
        return;
      }

      try {
        const response = await fetch(`${API_BASE}/session/acquire`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionIdRef.current }),
        });

        if (response.status === 423) {
          clearHeartbeat();
          setStatus("blocked");
          retryTimerRef.current = window.setTimeout(() => {
            void acquire();
          }, RETRY_INTERVAL_MS);
        }
      } catch {
        // Transient error: next tick will retry.
      }
    }
  }, [clearHeartbeat, clearRetry, releaseLockRequest]);

  const acquire = useCallback(async (): Promise<void> => {
    if (acquireInFlightRef.current) return;
    if (!sessionIdRef.current) {
      sessionIdRef.current = getOrCreateSessionId();
    }
    acquireInFlightRef.current = true;

    try {
      const response = await fetch(`${API_BASE}/session/acquire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionIdRef.current }),
      });

      if (response.status === 423) {
        clearHeartbeat();
        setStatus("blocked");
        clearRetry();
        retryTimerRef.current = window.setTimeout(() => {
          void acquire();
        }, RETRY_INTERVAL_MS);
        return;
      }

      if (!response.ok) {
        clearHeartbeat();
        setStatus("error");
        clearRetry();
        retryTimerRef.current = window.setTimeout(() => {
          void acquire();
        }, RETRY_INTERVAL_MS);
        return;
      }

      lastActivityRef.current = Date.now();
      setStatus("ok");
      clearRetry();
      startHeartbeat();
    } catch {
      clearHeartbeat();
      setStatus("error");
      clearRetry();
      retryTimerRef.current = window.setTimeout(() => {
        void acquire();
      }, RETRY_INTERVAL_MS);
    } finally {
      acquireInFlightRef.current = false;
    }
  }, [clearHeartbeat, clearRetry, startHeartbeat]);

  const logout = useCallback(async () => {
    clearHeartbeat();
    clearRetry();
    setStatus("logged_out");
    await releaseLockRequest();
  }, [clearHeartbeat, clearRetry, releaseLockRequest]);

  const loginAgain = useCallback(async () => {
    lastActivityRef.current = Date.now();
    setStatus("loading");
    await acquire();
  }, [acquire]);

  // Patch window.fetch on mount so every API request includes X-Session-Id.
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
        // Fall through to original fetch.
      }
      return originalFetch(input, init);
    };

    window.fetch = patchedFetch;

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  // Activity tracking for idle timeout.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const onActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "focus",
    ];

    for (const event of events) {
      window.addEventListener(event, onActivity, { passive: true } as AddEventListenerOptions);
    }

    return () => {
      for (const event of events) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, []);

  // Initial acquire on mount.
  useEffect(() => {
    void acquire();

    return () => {
      clearRetry();
      clearHeartbeat();
    };
  }, [acquire, clearHeartbeat, clearRetry]);

  // Best-effort release when the tab is closed.
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
          if (navigator.sendBeacon(url, blob)) return;
        }
      } catch {
        // Fall through to keepalive fetch.
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
        // Best-effort only.
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
    return (
      <SessionContext.Provider value={{ logout: () => void logout() }}>
        {children}
      </SessionContext.Provider>
    );
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
            <h3 className="modalTitle">Сессия занята</h3>
            <p className="modalText">Пробуем подключиться</p>
            <div className="syncProgress">
              <span className="spinner" aria-hidden="true" />
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

        {status === "idle" ? (
          <>
            <h3 className="modalTitle">Сессия завершена</h3>
            <p className="modalText">
              Сессия закрыта из-за бездействия (более 10 минут без активности). Это нужно, чтобы другие
              пользователи могли работать с системой.
            </p>
            <div className="modalActions">
              <button
                type="button"
                className="buttonPrimary"
                onClick={() => void loginAgain()}
              >
                Войти снова
              </button>
            </div>
          </>
        ) : null}

        {status === "logged_out" ? (
          <>
            <h3 className="modalTitle">Вы вышли из системы</h3>
            <p className="modalText">
              Сессия завершена. Теперь с системой может работать другой пользователь. Вы можете войти
              повторно в любой момент.
            </p>
            <div className="modalActions">
              <button
                type="button"
                className="buttonPrimary"
                onClick={() => void loginAgain()}
              >
                Войти снова
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
