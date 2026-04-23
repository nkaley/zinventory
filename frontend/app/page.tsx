"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

type ReportDevice = {
  id: number;
  zoho_composite_item_id: string;
  device_name: string;
  qty: number;
  created_at: string;
};

type ReportLine = {
  id: number;
  zoho_item_id: string;
  sku: string | null;
  item_name: string;
  manufacturer: string | null;
  vendor_code: string | null;
  category_name: string | null;
  rate: string;
  stock_available: string;
  quantity: string;
  qty_tbo: string;
  total_cost: string;
  related_composite: string | null;
  created_at: string;
  updated_at: string;
};

type Report = {
  id: number;
  title: string;
  status: string;
  total_cost: string;
  created_at: string;
  updated_at: string;
  devices: ReportDevice[];
  lines: ReportLine[];
};

type CompositeItem = {
  id: number;
  zoho_composite_item_id: string;
  sku: string | null;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type CompositeSearchResponse = {
  total: number;
  limit: number;
  offset: number;
  items: CompositeItem[];
};

type FullSyncResponse = {
  items: {
    fetched?: number | null;
    inserted?: number | null;
  };
  composites: {
    fetched_composites?: number | null;
    inserted_composites?: number | null;
    inserted_components?: number | null;
  };
};

type LastSyncResponse = {
  last_full_sync_at: string | null;
};

function formatRub(value: string | number): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

function formatReportStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "draft":
      return "Черновик";
    case "calculated":
      return "Рассчитан";
    default:
      return status;
  }
}

function formatUtcPlus3(dateIso: string): string {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function DeviceRow({
  device,
  qty,
  onQtyChange,
  onDelete,
}: {
  device: ReportDevice;
  qty: string;
  onQtyChange: (qty: string) => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td>{device.id}</td>
      <td>{device.device_name}</td>
      <td>{device.zoho_composite_item_id}</td>
      <td>
        <input
          className="smallInput"
          value={qty}
          onChange={(e) => onQtyChange(e.target.value)}
        />
      </td>
      <td>
        <div className="actions">
          <button className="buttonDanger" onClick={onDelete}>
            Удалить
          </button>
        </div>
      </td>
    </tr>
  );
}

function ExpandableRelatedComposite({ value }: { value: string | null }) {
  const text = value?.trim() ?? "";
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;

    // Show the button only when the collapsed text is actually truncated by cell width.
    const hasOverflow = element.scrollWidth > element.clientWidth;
    setCanExpand(hasOverflow);
  }, [text]);

  if (!text) {
    return <span className="muted">—</span>;
  }

  return (
    <div className="expandableCell">
      <div
        ref={textRef}
        className={expanded ? "expandableTextExpanded" : "expandableTextCollapsed"}
      >
        {text}
      </div>
      {canExpand ? (
        <button
          type="button"
          className="textButton"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Свернуть" : "Развернуть"}
        </button>
      ) : null}
    </div>
  );
}

export default function HomePage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null);
  const [newReportTitle, setNewReportTitle] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<CompositeItem[]>([]);
  const [deviceQtyDrafts, setDeviceQtyDrafts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [addingDevice, setAddingDevice] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [pendingDeleteReport, setPendingDeleteReport] = useState<Report | null>(null);

  const hasReports = reports.length > 0;
  const isBusy = loading || syncing;

  const selectedReport = useMemo(
    () => reports.find((r) => r.id === selectedReportId) ?? null,
    [reports, selectedReportId]
  );

  useEffect(() => {
    if (!selectedReport) {
      setDeviceQtyDrafts({});
      return;
    }

    const nextDrafts: Record<number, string> = {};
    for (const device of selectedReport.devices) {
      nextDrafts[device.id] = String(device.qty);
    }
    setDeviceQtyDrafts(nextDrafts);
  }, [selectedReport]);

  useEffect(() => {
    setSearch("");
    setSearchResults([]);
  }, [selectedReportId]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchJson<LastSyncResponse>(`${API_BASE}/sync/last`);
        setLastSyncAt(data.last_full_sync_at);
      } catch {
        setLastSyncAt(null);
      }
    })();
  }, []);

  async function loadReports(): Promise<void> {
    const data = await fetchJson<Report[]>(`${API_BASE}/reports`);
    setReports(data);

    if (data.length > 0 && selectedReportId == null) {
      setSelectedReportId(data[0].id);
    }

    if (data.length === 0) {
      setSelectedReportId(null);
    }

    if (
      selectedReportId != null &&
      !data.some((report) => report.id === selectedReportId)
    ) {
      setSelectedReportId(data[0]?.id ?? null);
    }
  }

  useEffect(() => {
    void loadReports();
  }, []);

  async function loadReport(reportId: number): Promise<void> {
    const report = await fetchJson<Report>(`${API_BASE}/reports/${reportId}`);
    setReports((prev) => {
      const exists = prev.some((item) => item.id === report.id);
      if (exists) {
        return prev.map((item) => (item.id === report.id ? report : item));
      }
      return [report, ...prev];
    });
  }

  async function handleFullSync(): Promise<void> {
    setSyncing(true);

    try {
      const result = await fetchJson<FullSyncResponse>(`${API_BASE}/sync/full`, {
        method: "POST",
      });
      const nowIso = new Date().toISOString();
      setLastSyncAt(nowIso);
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setSyncing(false);
    }
  }

  async function handleCreateReport(): Promise<void> {
    if (!newReportTitle.trim()) return;

    setLoading(true);

    try {
      const created = await fetchJson<Report>(`${API_BASE}/reports`, {
        method: "POST",
        body: JSON.stringify({ title: newReportTitle.trim() }),
      });

      setNewReportTitle("");
      await loadReports();
      setSelectedReportId(created.id);
      await loadReport(created.id);
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setLoading(false);
    }
  }

  async function searchComposites(query: string): Promise<void> {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);

    try {
      const data = await fetchJson<CompositeSearchResponse>(
        `${API_BASE}/catalog/composites?q=${encodeURIComponent(query)}&limit=20&offset=0`
      );
      setSearchResults(data.items);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }

  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void searchComposites(query);
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [search]);

  async function handleAddDevice(item: CompositeItem): Promise<void> {
    if (!selectedReport) return;

    setAddingDevice(true);

    try {
      const createdDevice = await fetchJson<ReportDevice>(
        `${API_BASE}/reports/${selectedReport.id}/devices`,
        {
        method: "POST",
        body: JSON.stringify({
          zoho_composite_item_id: item.zoho_composite_item_id,
          device_name: item.name,
          qty: 1,
        }),
        }
      );

      // Update only the selected report locally to avoid full-page UI jumps.
      setReports((prev) =>
        prev.map((report) =>
          report.id === selectedReport.id
            ? {
                ...report,
                status: "draft",
                lines: [],
                devices: [...report.devices, createdDevice],
              }
            : report
        )
      );
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setAddingDevice(false);
    }
  }

  function getChangedDevices(report: Report): Array<{ id: number; nextQty: number }> {
    return report.devices
      .map((device) => ({
        id: device.id,
        currentQty: device.qty,
        nextQty: Number(deviceQtyDrafts[device.id] ?? device.qty),
      }))
      .filter(
        (item) =>
          Number.isFinite(item.nextQty) &&
          item.nextQty > 0 &&
          item.nextQty !== item.currentQty
      )
      .map((item) => ({ id: item.id, nextQty: item.nextQty }));
  }

  async function saveDeviceDrafts(report: Report): Promise<void> {
    const changedDevices = getChangedDevices(report);
    if (changedDevices.length === 0) return;

    await Promise.all(
      changedDevices.map((item) =>
        fetchJson<ReportDevice>(`${API_BASE}/reports/${report.id}/devices/${item.id}`, {
          method: "PATCH",
          body: JSON.stringify({ qty: item.nextQty }),
        })
      )
    );
  }

  async function handleCalculate(): Promise<void> {
    if (!selectedReport) return;

    const changedDevices = selectedReport.devices
      .map((device) => ({
        id: device.id,
        currentQty: device.qty,
        nextQty: Number(deviceQtyDrafts[device.id] ?? device.qty),
      }))
      .filter(
        (item) =>
          Number.isFinite(item.nextQty) &&
          item.nextQty > 0 &&
          item.nextQty !== item.currentQty
      );

    setLoading(true);

    try {
      if (changedDevices.length > 0) {
        await saveDeviceDrafts(selectedReport);
      }

      await fetchJson<{ report_id: number; total_cost: string; lines_count: number }>(
        `${API_BASE}/reports/${selectedReport.id}/calculate`,
        { method: "POST" }
      );
      await loadReport(selectedReport.id);
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteDevice(deviceId: number): Promise<void> {
    if (!selectedReport) return;

    setLoading(true);

    try {
      await fetchJson<{ message: string }>(
        `${API_BASE}/reports/${selectedReport.id}/devices/${deviceId}`,
        { method: "DELETE" }
      );

      await loadReport(selectedReport.id);
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setLoading(false);
    }
  }

  async function confirmDeleteReport(reportId: number): Promise<void> {
    setLoading(true);

    try {
      await fetchJson<{ message: string }>(`${API_BASE}/reports/${reportId}`, {
        method: "DELETE",
      });

      const nextReports = reports.filter((item) => item.id !== reportId);
      setReports(nextReports);
      setSelectedReportId((prev) => {
        if (prev !== reportId) return prev;
        return nextReports[0]?.id ?? null;
      });
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setLoading(false);
      setPendingDeleteReport(null);
    }
  }

  function openDeleteReportModal(reportId: number): void {
    const report = reports.find((item) => item.id === reportId) ?? null;
    setPendingDeleteReport(report);
  }

  function handleExport(): void {
    if (!selectedReport) return;
    window.open(`${API_BASE}/reports/${selectedReport.id}/export/xlsx`, "_blank");
  }

  return (
    <main className="page">
      <div className="topBar">
        <div className="title">Zinventory</div>
        <div className="topBarActions">
          <button
            className="buttonSync"
            onClick={() => void handleFullSync()}
            disabled={syncing}
          >
            {syncing ? "Обновление..." : "Обновить базу"}
          </button>
          <div className="lastSyncText">
            {lastSyncAt
              ? `Последнее обновление: ${formatUtcPlus3(lastSyncAt)} (UTC+3)`
              : "Последнее обновление: —"}
          </div>
        </div>
      </div>

      <div className="grid">
        <section className="card">
          <div className="sectionTitle">Отчеты</div>

          <div className="col">
            <input
              className="input"
              placeholder="Введите название нового отчета"
              value={newReportTitle}
              onChange={(e) => setNewReportTitle(e.target.value)}
            />
            <button
              className="buttonPrimary"
              onClick={() => void handleCreateReport()}
              disabled={isBusy || !newReportTitle.trim()}
            >
              Создать отчет
            </button>
          </div>

          <div className="divider" />

          <div className="reportList">
            {hasReports ? (
              reports.map((report) => (
                <button
                  key={report.id}
                  className={`reportItem ${selectedReportId === report.id ? "reportItemActive" : ""}`}
                  onClick={() => setSelectedReportId(report.id)}
                  style={{ textAlign: "left" }}
                >
                  <div><strong>{report.title}</strong></div>
                  <div className="muted">ID: {report.id}</div>
                  <div className="muted">Статус: {report.status}</div>
                  <div className="muted">Сумма: {report.total_cost}</div>
                </button>
              ))
            ) : (
              <div className="muted">Нет отчетов.</div>
            )}
          </div>
        </section>

        <section className="col" style={{ gap: 20 }}>
          {selectedReport ? (
            <>
              <div className="card">
                <div className="sectionTitle">Выбранный отчет</div>

                <div className="kv">
                  <div>Номер отчета</div>
                  <div>{selectedReport.id}</div>

                  <div>Название</div>
                  <div>{selectedReport.title}</div>

                  <div>Статус</div>
                  <div><span className="badge">{formatReportStatus(selectedReport.status)}</span></div>

                  <div>Итоговая сумма (руб.)</div>
                  <div><strong>{formatRub(selectedReport.total_cost)}</strong></div>
                </div>

                <div className="divider" />

                <div className="actions">
                  <button
                    className="buttonSecondary"
                    onClick={handleExport}
                    disabled={isBusy}
                  >
                    Экспорт в XLSX
                  </button>
                  <button
                    className="buttonDanger"
                    onClick={() => openDeleteReportModal(selectedReport.id)}
                    disabled={isBusy}
                  >
                    Удалить отчет
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="sectionTitle">Добавить устройство</div>

                <div className="deviceSelect">
                  <div className="deviceSelectMenu">
                    <input
                      className="input"
                      placeholder="Поиск по названию или SKU"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />

                    {searchLoading ? <div className="muted searchHint">Поиск...</div> : null}

                    {search.trim() && !searchLoading && searchResults.length === 0 ? (
                      <div className="muted searchHint">Совпадений не найдено.</div>
                    ) : null}

                    {searchResults.length > 0 ? (
                      <div className="searchResults compactSearchResults">
                        {searchResults.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            className="searchItemButton"
                            disabled={addingDevice}
                            onClick={() => void handleAddDevice(item)}
                          >
                            <div><strong>{item.name}</strong></div>
                            <div className="muted">
                              {item.sku ?? "—"} · {item.zoho_composite_item_id}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="divider" />
              </div>

              <div className="card">
                <div className="sectionTitle">Устройства в отчете</div>

                {selectedReport.devices.length === 0 ? (
                  <div className="muted">В отчете пока нет устройств.</div>
                ) : (
                  <div className="tableWrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Название</th>
                          <th>ID комплекта</th>
                          <th>Кол-во</th>
                          <th>Действия</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedReport.devices.map((device) => (
                          <DeviceRow
                            key={device.id}
                            device={device}
                            qty={deviceQtyDrafts[device.id] ?? String(device.qty)}
                            onQtyChange={(qty) =>
                              setDeviceQtyDrafts((prev) => ({ ...prev, [device.id]: qty }))
                            }
                            onDelete={() => void handleDeleteDevice(device.id)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="actions">
                  <button
                    className="buttonPrimary"
                    onClick={() => void handleCalculate()}
                    disabled={isBusy || selectedReport.devices.length === 0}
                  >
                    Рассчитать
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="sectionTitle">Результаты расчета</div>

                {selectedReport.lines.length === 0 ? (
                  <div className="muted">Нет данных.</div>
                ) : (
                  <div className="tableWrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Номенклатура</th>
                          <th>SKU</th>
                          <th>Производитель</th>
                          <th>Артикул</th>
                          <th>Категория</th>
                          <th>Цена</th>
                          <th>Остаток</th>
                          <th>Количество</th>
                          <th>Кол-во ТБО</th>
                          <th>Стоимость</th>
                          <th>Связанный комплект</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedReport.lines.map((line) => (
                          <tr key={line.id}>
                            <td>{line.item_name}</td>
                            <td>{line.sku ?? ""}</td>
                            <td>{line.manufacturer ?? ""}</td>
                            <td>{line.vendor_code ?? ""}</td>
                            <td>{line.category_name ?? ""}</td>
                            <td>{line.rate}</td>
                            <td>{line.stock_available}</td>
                            <td>{line.quantity}</td>
                            <td>{line.qty_tbo}</td>
                            <td>{line.total_cost}</td>
                            <td className="relatedCompositeCell">
                              <ExpandableRelatedComposite value={line.related_composite} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="card">
              <div className="muted">Отчет не выбран.</div>
            </div>
          )}
        </section>
      </div>
      {pendingDeleteReport ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-report-title"
        >
          <div className="modalCard">
            <h3 id="delete-report-title" className="modalTitle">
              Подтвердите удаление
            </h3>
            <p className="modalText">
              Отчет <strong>{pendingDeleteReport.title}</strong> будет удален без возможности
              восстановления.
            </p>
            <div className="modalActions">
              <button
                type="button"
                className="buttonSecondary"
                onClick={() => setPendingDeleteReport(null)}
                disabled={loading}
              >
                Отмена
              </button>
              <button
                type="button"
                className="buttonDanger"
                onClick={() => void confirmDeleteReport(pendingDeleteReport.id)}
                disabled={loading}
              >
                {loading ? "Удаление..." : "Удалить отчет"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {syncing ? (
        <div className="modalOverlay" role="alertdialog" aria-modal="true" aria-live="assertive">
          <div className="modalCard">
            <h3 className="modalTitle">Идет обновление базы</h3>
            <p className="modalText">
              Это может занять до 10 минут. Пожалуйста, не закрывайте страницу и не
              останавливайте процесс.
            </p>
            <div className="syncProgress">
              <span className="spinner" aria-hidden="true" />
              <span>Обновляем данные...</span>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}