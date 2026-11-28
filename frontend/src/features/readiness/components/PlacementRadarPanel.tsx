import { useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Compass,
  Download,
  Printer,
  RefreshCw,
} from "lucide-react";
import axiosClient from "../../../utils/axiosClient";
import { ReadinessSpiderChart } from "./ReadinessSpiderChart";
import {
  PRACTICE_GOALS,
  radarReportText,
  type PlacementRadarReport,
} from "../placementRadar";

function formatPlatformName(platform: string): string {
  const lower = platform.trim().toLowerCase();
  if (lower === "leetcode") return "LeetCode";
  if (lower === "codeforces") return "Codeforces";
  if (lower === "codechef") return "CodeChef";
  if (lower === "atcoder") return "AtCoder";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

export function PlacementRadarPanel() {
  const { userId, isSignedIn, isLoaded } = useAuth();
  const [tier, setTier] = useState<keyof typeof PRACTICE_GOALS>("intermediate");
  const [expandedAxes, setExpandedAxes] = useState<Record<string, boolean>>({});
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["placementRadar", userId],
    enabled: isLoaded && isSignedIn,
    queryFn: async ({ signal }) => {
      const response = await axiosClient.get<{
        success: boolean;
        data: PlacementRadarReport;
      }>("/readiness/placement-radar", { signal });
      if (!response.data.success) throw new Error("Radar unavailable");
      return response.data.data;
    },
    staleTime: 60000,
    retry: 1,
  });
  const [exportError, setExportError] = useState("");
  function download() {
    if (!data) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([radarReportText(data, PRACTICE_GOALS[tier])], {
          type: "text/plain;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "placement-practice-report.txt";
      link.click();
      setExportError("");
    } catch {
      setExportError("Report could not be downloaded. Try printing instead.");
    } finally {
      if (url) window.setTimeout(() => URL.revokeObjectURL(url!), 1000);
    }
  }

  const contestLabel = data?.signals.contestPlatforms?.length
    ? data.signals.contestPlatforms
        .map((c) => `${formatPlatformName(c.platform)}: ${c.rating}`)
        .join(", ")
    : data?.signals.contestRatings.join(", ") || "Unknown";

  return (
    <section
      aria-labelledby="placement-title"
      className="rounded-2xl border border-slate-200/80 bg-white p-6 text-slate-800 shadow-xs overflow-hidden"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-100">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
            <Compass size={17} className="text-indigo-600" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id="placement-title" className="text-lg font-bold text-slate-900">
              Placement practice radar
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Five evidence axes, practice diagnostics, and an exportable report.
            </p>
          </div>
        </div>

        {data && (
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-1.5 text-xs font-semibold text-slate-600">
              <span>Practice goal</span>
              <select
                value={tier}
                onChange={(e) =>
                  setTier(e.target.value as keyof typeof PRACTICE_GOALS)
                }
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 focus:border-indigo-400 focus:outline-none cursor-pointer"
              >
                {Object.keys(PRACTICE_GOALS).map((key) => (
                  <option key={key} value={key}>
                    {key} ({PRACTICE_GOALS[key as keyof typeof PRACTICE_GOALS]}/100)
                  </option>
                ))}
              </select>
            </label>
            <span className="inline-flex items-center rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 tabular-nums">
              {data.coverage}/5 axes
            </span>
          </div>
        )}
      </div>

      {isLoading && (
        <p role="status" className="py-8 text-sm text-slate-500 font-medium">
          Loading practice evidence…
        </p>
      )}
      {isError && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          <span>Practice evidence could not be loaded.</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 cursor-pointer"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Retry radar
          </button>
        </div>
      )}

      {data && (
        <div className="mt-4 space-y-6">
          <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-600">{data.caveat}</p>
            <p className="text-[11px] font-medium text-slate-500">
              Illustrative goals only. No company tier or hiring percentile is inferred.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-5 min-w-0 rounded-xl border border-slate-200/70 bg-slate-50/40 p-4">
              <ReadinessSpiderChart
                targetLabel={`${tier} practice goal`}
                dimensions={data.axes.map((a) => ({
                  key: a.key,
                  label: a.label,
                  score: a.score ?? 0,
                  unavailable: a.score === null,
                  target: PRACTICE_GOALS[tier],
                  gap: a.gap,
                }))}
              />
              <p className="text-[11px] text-slate-500 text-center mt-2">
                Unknown axes are drawn at the center for layout only; use the table for evidence status.
              </p>
            </div>

            <div className="lg:col-span-7 min-w-0 overflow-x-auto rounded-xl border border-slate-200/80">
              <table className="w-full text-sm text-left border-collapse">
                <caption className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500 bg-slate-50/80 border-b border-slate-200/80">
                  Evidence and diagnosis (last seven days)
                </caption>
                <thead className="bg-slate-50/50 text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200/80">
                  <tr>
                    <th scope="col" className="px-3 py-2.5">Axis</th>
                    <th scope="col" className="px-3 py-2.5 whitespace-nowrap">Score</th>
                    <th scope="col" className="px-3 py-2.5">Diagnosis</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.axes.map((a) => {
                    const isExpanded = Boolean(expandedAxes[a.key]);
                    const visibleEvidence = isExpanded ? a.evidence : a.evidence.slice(0, 4);
                    const hasMore = a.evidence.length > 4;
                    return (
                      <tr key={a.key} className="hover:bg-slate-50/50 transition-colors align-top">
                        <th scope="row" className="px-3 py-3 font-semibold text-slate-800 whitespace-nowrap">
                          {a.label}
                        </th>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {a.score === null ? (
                            <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                              Unknown
                            </span>
                          ) : (
                            <span
                              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-bold tabular-nums ${
                                a.score >= PRACTICE_GOALS[tier]
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : a.score >= 45
                                    ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                                    : "border-amber-200 bg-amber-50 text-amber-700"
                              }`}
                            >
                              {a.score}/100
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                          <p className="text-xs font-medium text-slate-700 leading-relaxed">{a.gap}</p>
                          {a.evidence.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              {visibleEvidence.map((e) => (
                                <span
                                  key={e}
                                  className="inline-flex items-center rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 tabular-nums"
                                >
                                  {e}
                                </span>
                              ))}
                              {hasMore && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedAxes((prev) => ({
                                      ...prev,
                                      [a.key]: !prev[a.key],
                                    }))
                                  }
                                  className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-50 transition-colors cursor-pointer"
                                >
                                  {isExpanded ? (
                                    <>
                                      Show less <ChevronUp size={12} aria-hidden="true" />
                                    </>
                                  ) : (
                                    <>
                                      View all {a.evidence.length} topics <ChevronDown size={12} aria-hidden="true" />
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Signals Summary Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Contest ratings (platform scales differ)
              </p>
              <p className="mt-1 text-sm font-bold text-slate-800 tabular-nums">{contestLabel}</p>
            </div>
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Review retention
              </p>
              <p className="mt-1 text-sm font-bold text-slate-800 tabular-nums">
                {data.signals.retentionPercent === null
                  ? "Unknown"
                  : `${data.signals.retentionPercent}%`}{" "}
                <span className="text-xs font-medium text-slate-500">
                  ({data.signals.reviews7d} reviews)
                </span>
              </p>
            </div>
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/60 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                7-day solve consistency
              </p>
              <p className="mt-1 text-sm font-bold text-slate-800 tabular-nums">
                {data.signals.consistencyPercent === null
                  ? "Unknown"
                  : `${data.signals.consistencyPercent}%`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
            <p className="text-xs text-slate-400 tabular-nums">
              Generated {new Date(data.generatedAt).toLocaleString()} · {data.version}
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={download}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-xs hover:bg-slate-50 hover:border-slate-300 transition-colors cursor-pointer"
              >
                <Download size={14} aria-hidden="true" />
                Export text report
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-xs hover:bg-slate-50 hover:border-slate-300 transition-colors cursor-pointer"
              >
                <Printer size={14} aria-hidden="true" />
                Print / Save PDF
              </button>
            </div>
          </div>
          {exportError && (
            <p role="alert" className="text-xs font-medium text-rose-600">
              {exportError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
