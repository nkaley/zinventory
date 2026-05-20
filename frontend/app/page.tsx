"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useSession } from "./SessionGate";

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
  build_cost: string;
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

type CompositeCostZeroComponent = {
  zoho_item_id: string;
  name: string;
  sku: string | null;
  quantity: number;
};

type CompositeCostCandidate = {
  composite_id: string;
  name: string;
  sku: string | null;
  current_purchase_rate: number;
  new_purchase_rate: number;
  delta: number;
  zero_rate_components: CompositeCostZeroComponent[];
  status: "updated" | "error" | null;
  error: string | null;
};

type CompositeCostRecalcResult = {
  dry_run: boolean;
  threshold: number;
  checked: number;
  skipped_no_change: number;
  skipped_empty_bom: number;
  candidates: CompositeCostCandidate[];
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

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=UTF-8''([^;\n]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      return star[1].trim();
    }
  }
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const bare = header.match(/filename=([^;\s]+)/i);
  if (bare?.[1]) return bare[1].replace(/^"(.*)"$/, "$1");
  return null;
}

function fileBasename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed.replace(/^.*[/\\]/, "");
  return base || trimmed;
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
  const { logout } = useSession();
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null);
  const [newReportTitle, setNewReportTitle] = useState("");
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [searchResults, setSearchResults] = useState<CompositeItem[]>([]);
  const [deviceQtyDrafts, setDeviceQtyDrafts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [addingDevice, setAddingDevice] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [pendingDeleteReport, setPendingDeleteReport] = useState<Report | null>(null);
  const [forceSyncConfirm, setForceSyncConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [costRecalcLoading, setCostRecalcLoading] = useState(false);
  const [costRecalcResult, setCostRecalcResult] =
    useState<CompositeCostRecalcResult | null>(null);
  const [costRecalcOpen, setCostRecalcOpen] = useState(false);
  const [costSelectedIds, setCostSelectedIds] = useState<Set<string>>(
    new Set()
  );
  const [applyCostsConfirm, setApplyCostsConfirm] = useState(false);

  const hasReports = reports.length > 0;
  const isBusy = loading || syncing;
  const isCostRecalcBusy = costRecalcLoading;

  const selectedReport = useMemo(
    () => reports.find((r) => r.id === selectedReportId) ?? null,
    [reports, selectedReportId]
  );

  useEffect(() => {
    if (!selectedReport) {
      setDeviceQtyDrafts({});
      return;
    }

    // Preserve user-edited drafts across report refreshes (e.g. after adding
    // another device). Only initialize entries for devices we haven't seen
    // yet, and drop drafts for devices that no longer exist.
    setDeviceQtyDrafts((prev) => {
      const next: Record<number, string> = {};
      for (const device of selectedReport.devices) {
        next[device.id] = prev[device.id] ?? String(device.qty);
      }
      return next;
    });
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

  async function handleFullSync(force = false): Promise<void> {
    setSyncing(true);

    try {
      const url = force ? `${API_BASE}/sync/full?force=true` : `${API_BASE}/sync/full`;
      const result = await fetchJson<FullSyncResponse>(url, {
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

  async function openCostRecalcModal(): Promise<void> {
    setCostRecalcOpen(true);
    setCostRecalcResult(null);
    setCostSelectedIds(new Set());
    setCostRecalcLoading(true);
    try {
      const url = `${API_BASE}/catalog/composites/recalculate-costs?dry_run=true`;
      const result = await fetchJson<CompositeCostRecalcResult>(url, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setCostRecalcResult(result);
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setCostRecalcLoading(false);
    }
  }

  async function applySelectedCosts(): Promise<void> {
    const ids = Array.from(costSelectedIds);
    if (ids.length === 0) return;

    setCostRecalcLoading(true);
    try {
      const url = `${API_BASE}/catalog/composites/recalculate-costs?dry_run=false`;
      const result = await fetchJson<CompositeCostRecalcResult>(url, {
        method: "POST",
        body: JSON.stringify({ composite_ids: ids }),
      });

      setCostRecalcResult((prev) => {
        if (!prev) return result;
        const byId = new Map(
          result.candidates.map((row) => [row.composite_id, row])
        );
        const mergedCandidates = prev.candidates.map((row) => {
          const updated = byId.get(row.composite_id);
          return updated ? { ...row, ...updated } : row;
        });
        return { ...prev, candidates: mergedCandidates };
      });
      setCostSelectedIds(new Set());
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setCostRecalcLoading(false);
    }
  }

  function closeCostRecalcModal(): void {
    setCostRecalcOpen(false);
    setCostRecalcResult(null);
    setCostSelectedIds(new Set());
  }

  function toggleCostSelection(compositeId: string): void {
    setCostSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(compositeId)) {
        next.delete(compositeId);
      } else {
        next.add(compositeId);
      }
      return next;
    });
  }

  function toggleSelectAllCosts(
    candidates: CompositeCostCandidate[],
    selectAll: boolean
  ): void {
    if (selectAll) {
      const selectable = candidates
        .filter((row) => row.status !== "updated")
        .map((row) => row.composite_id);
      setCostSelectedIds(new Set(selectable));
    } else {
      setCostSelectedIds(new Set());
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

  async function searchComposites(query: string, includeInactiveParam: boolean): Promise<void> {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);

    try {
      const data = await fetchJson<CompositeSearchResponse>(
        `${API_BASE}/catalog/composites?q=${encodeURIComponent(query)}&limit=20&offset=0&include_inactive=${includeInactiveParam}`
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
      void searchComposites(query, includeInactive);
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [search, includeInactive]);

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
      setSearch("");
      setSearchResults([]);
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
      setSelectedReportId((prev) => (prev === reportId ? null : prev));
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

  async function handleExport(): Promise<void> {
    if (!selectedReport) return;
    setExporting(true);
    try {
      const response = await fetch(`${API_BASE}/reports/${selectedReport.id}/export/xlsx`);
      if (!response.ok) return;
      const blob = await response.blob();
      const fromHeader = filenameFromContentDisposition(
        response.headers.get("Content-Disposition")
      );
      const downloadName = fileBasename(
        fromHeader ?? `report-${selectedReport.id}.xlsx`
      );
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = downloadName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Silent fail: notifications are disabled by design.
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="page">
      <div className="topBar">
        <div className="title">Zinventory</div>
        <div className="topBarActions">
          <div className="topBarButtons">
            <button
              className="buttonSecondary"
              onClick={logout}
              disabled={syncing}
            >
              Выйти
            </button>
            <button
              className="buttonSecondary"
              onClick={() => void openCostRecalcModal()}
              disabled={syncing || isCostRecalcBusy}
              title="Посчитать новый purchase_rate для сборок и при желании обновить выбранные в Zoho."
            >
              Себестоимость сборок
            </button>
            <button
              className="buttonSecondary"
              onClick={() => setForceSyncConfirm(true)}
              disabled={syncing}
              title="Перевыкачать все детали композитов из Zoho. Использует много API-токенов."
            >
              Полная синхронизация
            </button>
            <button
              className="buttonSync"
              onClick={() => void handleFullSync(false)}
              disabled={syncing}
            >
              {syncing ? "Обновление..." : "Обновить базу"}
            </button>
          </div>
          <div className="lastSyncText">
            {lastSyncAt
              ? `Последнее обновление: ${formatUtcPlus3(lastSyncAt)} (UTC+3)`
              : "Последнее обновление: —"}
          </div>
        </div>
      </div>

      <div className="layoutStack">
        <div className="topGrid">
          <section className="card reportSelectorCard">
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

            <div className="col">
              <div className="muted">Выбор отчета</div>
              <select
                className="input"
                value={selectedReportId ?? ""}
                onChange={(e) => setSelectedReportId(e.target.value ? Number(e.target.value) : null)}
                disabled={!hasReports}
              >
                <option value="" disabled>
                  {hasReports ? "Выберите отчет" : "Нет отчетов"}
                </option>
                {reports.map((report) => (
                  <option key={report.id} value={report.id}>
                    {`${report.title} · ID ${report.id} · ${formatUtcPlus3(report.created_at)}`}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="card">
            <div className="sectionTitle">Выбранный отчет</div>
            {selectedReport ? (
              <>
                <div className="kv">
                  <div>Номер отчета</div>
                  <div>{selectedReport.id}</div>

                  <div>Название</div>
                  <div>{selectedReport.title}</div>

                  <div>Статус</div>
                  <div><span className="badge">{formatReportStatus(selectedReport.status)}</span></div>

                  <div>Дата создания</div>
                  <div>{formatUtcPlus3(selectedReport.created_at)}</div>

                  <div>Себестоимость сборки (руб.)</div>
                  <div><strong>{formatRub(selectedReport.build_cost)}</strong></div>

                  <div>Итоговая сумма (руб.)</div>
                  <div><strong>{formatRub(selectedReport.total_cost)}</strong></div>
                </div>

                <div className="divider" />

                <div className="actions">
                  <button
                    className="buttonSecondary"
                    onClick={() => void handleExport()}
                    disabled={isBusy || exporting}
                  >
                    {exporting ? "Экспорт…" : "Экспорт в XLSX"}
                  </button>
                  <button
                    className="buttonDanger"
                    onClick={() => openDeleteReportModal(selectedReport.id)}
                    disabled={isBusy}
                  >
                    Удалить отчет
                  </button>
                </div>
              </>
            ) : (
              <div className="muted">Отчет не выбран.</div>
            )}
          </section>
        </div>

        {selectedReport ? (
          <section className="col" style={{ gap: 20 }}>
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

                    <label className="checkboxRow">
                      <input
                        type="checkbox"
                        checked={includeInactive}
                        onChange={(e) => setIncludeInactive(e.target.checked)}
                      />
                      <span>Показывать неактивные</span>
                    </label>

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
                            <div>
                              <strong>{item.name}</strong>
                              {!item.is_active ? (
                                <span className="inactiveBadge">неактивен</span>
                              ) : null}
                            </div>
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
                          <th>Стоимость на сборку</th>
                          <th>Кол-во ТБО</th>
                          <th>Стоимость</th>
                          <th>Связанный комплект</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedReport.lines.map((line) => {
                          const buildCost =
                            Number(line.rate) * Number(line.quantity);
                          return (
                            <tr key={line.id}>
                              <td>{line.item_name}</td>
                              <td>{line.sku ?? ""}</td>
                              <td>{line.manufacturer ?? ""}</td>
                              <td>{line.vendor_code ?? ""}</td>
                              <td>{line.category_name ?? ""}</td>
                              <td>{line.rate}</td>
                              <td>{line.stock_available}</td>
                              <td>{line.quantity}</td>
                              <td>
                                {Number.isFinite(buildCost)
                                  ? buildCost.toFixed(2)
                                  : "—"}
                              </td>
                              <td>{line.qty_tbo}</td>
                              <td>{line.total_cost}</td>
                              <td className="relatedCompositeCell">
                                <ExpandableRelatedComposite
                                  value={line.related_composite}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          </section>
        ) : null}
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

      {forceSyncConfirm ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="force-sync-title"
        >
          <div className="modalCard">
            <h3 id="force-sync-title" className="modalTitle">
              Полная синхронизация
            </h3>
            <p className="modalText">
              Перевыкачает детали всех комплектов из Zoho, даже если они не менялись.
              Тратит много API-токенов (примерно по одному на каждый комплект).
              Используйте, только если данные в локальной базе расходятся с Zoho.
            </p>
            <div className="modalActions">
              <button
                type="button"
                className="buttonSecondary"
                onClick={() => setForceSyncConfirm(false)}
                disabled={syncing}
              >
                Отмена
              </button>
              <button
                type="button"
                className="buttonPrimary"
                onClick={() => {
                  setForceSyncConfirm(false);
                  void handleFullSync(true);
                }}
                disabled={syncing}
              >
                Запустить
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {costRecalcOpen ? (
        <CostRecalcModal
          result={costRecalcResult}
          loading={isCostRecalcBusy}
          selectedIds={costSelectedIds}
          onToggleOne={toggleCostSelection}
          onToggleAll={(selectAll) =>
            toggleSelectAllCosts(costRecalcResult?.candidates ?? [], selectAll)
          }
          onApply={() => setApplyCostsConfirm(true)}
          onClose={closeCostRecalcModal}
        />
      ) : null}

      {applyCostsConfirm ? (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="apply-costs-title"
        >
          <div className="modalCard">
            <h3 id="apply-costs-title" className="modalTitle">
              Обновить себестоимость в Zoho?
            </h3>
            <p className="modalText">
              Будет обновлена себестоимость для{" "}
              <strong>{costSelectedIds.size}</strong>{" "}
              {costSelectedIds.size === 1 ? "сборки" : "сборок"}. Это может
              занять несколько минут — не закрывайте страницу.
            </p>
            <div className="modalActions">
              <button
                type="button"
                className="buttonSecondary"
                onClick={() => setApplyCostsConfirm(false)}
                disabled={isCostRecalcBusy}
              >
                Отмена
              </button>
              <button
                type="button"
                className="buttonPrimary"
                onClick={() => {
                  setApplyCostsConfirm(false);
                  void applySelectedCosts();
                }}
                disabled={isCostRecalcBusy || costSelectedIds.size === 0}
              >
                Обновить
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function CostRecalcModal({
  result,
  loading,
  selectedIds,
  onToggleOne,
  onToggleAll,
  onApply,
  onClose,
}: {
  result: CompositeCostRecalcResult | null;
  loading: boolean;
  selectedIds: Set<string>;
  onToggleOne: (compositeId: string) => void;
  onToggleAll: (selectAll: boolean) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const candidates = result?.candidates ?? [];
  const selectableIds = candidates
    .filter((row) => row.status !== "updated")
    .map((row) => row.composite_id);
  const selectedCount = selectedIds.size;
  const selectableCount = selectableIds.length;
  const allSelected =
    selectableCount > 0 && selectedCount === selectableCount;
  const someSelected = selectedCount > 0 && !allSelected;

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  return (
    <div
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cost-recalc-title"
    >
      <div className="modalCard modalCardWide">
        <h3 id="cost-recalc-title" className="modalTitle">
          Себестоимость сборок
        </h3>

        {!result ? (
          <div className="syncProgress">
            <span className="spinner" aria-hidden="true" />
            <span>Считаем кандидатов...</span>
          </div>
        ) : (
          <>
            <p className="modalText">
              Проверено: <strong>{result.checked}</strong>. Без изменений:{" "}
              <strong>{result.skipped_no_change}</strong>. Пустой состав:{" "}
              <strong>{result.skipped_empty_bom}</strong>. Кандидатов:{" "}
              <strong>{candidates.length}</strong>. Выбрано:{" "}
              <strong>{selectedCount}</strong>.
            </p>

            {candidates.length === 0 ? (
              <p className="modalText">Нет сборок, требующих обновления.</p>
            ) : (
              <div className="recalcSection">
                <div className="recalcTableWrap">
                  <table className="recalcTable">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>
                          <input
                            ref={selectAllRef}
                            type="checkbox"
                            checked={allSelected}
                            onChange={(e) => onToggleAll(e.target.checked)}
                            disabled={loading || selectableCount === 0}
                            aria-label="Выбрать все"
                          />
                        </th>
                        <th>SKU</th>
                        <th>Название</th>
                        <th className="num">Сейчас</th>
                        <th className="num">Новая</th>
                        <th className="num">Δ</th>
                        <th>Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((row) => {
                        const isUpdated = row.status === "updated";
                        const isError = row.status === "error";
                        const tooltip =
                          row.zero_rate_components.length > 0
                            ? "У этих компонентов нет цены — их вклад в себестоимость равен 0:\n" +
                              row.zero_rate_components
                                .map(
                                  (c) =>
                                    `• ${c.name}${
                                      c.sku ? ` (SKU ${c.sku})` : ""
                                    } — ${c.quantity} шт`
                                )
                                .join("\n")
                            : "";
                        return (
                          <tr key={row.composite_id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selectedIds.has(row.composite_id)}
                                onChange={() => onToggleOne(row.composite_id)}
                                disabled={loading || isUpdated}
                                aria-label="Выбрать"
                              />
                            </td>
                            <td>{row.sku ?? "—"}</td>
                            <td>
                              {row.name}
                              {tooltip ? (
                                <span
                                  className="costWarn"
                                  title={tooltip}
                                  aria-label="Предупреждение"
                                >
                                  {" "}
                                  !
                                </span>
                              ) : null}
                            </td>
                            <td className="num">
                              {formatRub(row.current_purchase_rate)}
                            </td>
                            <td className="num">
                              {formatRub(row.new_purchase_rate)}
                            </td>
                            <td className="num">{formatRub(row.delta)}</td>
                            <td>
                              {isUpdated ? (
                                <span className="costStatusOk">Обновлено</span>
                              ) : isError ? (
                                <span
                                  className="costStatusErr"
                                  title={row.error ?? ""}
                                >
                                  Ошибка
                                </span>
                              ) : (
                                ""
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        <div className="modalActions">
          <button
            type="button"
            className="buttonSecondary"
            onClick={onClose}
            disabled={loading}
          >
            Закрыть
          </button>
          <button
            type="button"
            className="buttonPrimary"
            onClick={onApply}
            disabled={loading || selectedCount === 0}
          >
            {loading
              ? "Идет обновление..."
              : `Обновить выбранные (${selectedCount}) в Zoho`}
          </button>
        </div>
      </div>
    </div>
  );
}