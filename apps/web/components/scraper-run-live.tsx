"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ScraperRunStatus = "RUNNING" | "AWAITING_INPUT" | "COMPLETED" | "INTERRUPTED" | "FAILED";

export type ScraperRunPollResult = {
  status: ScraperRunStatus;
  logOutput: string | null;
  filesIngestedCount: number;
  pendingPrompt: string | null;
};

type ScraperRunSummary = {
  id: string;
  status: ScraperRunStatus;
  startedAt: string;
  finishedAt: string | null;
  logOutput: string | null;
  filesIngestedCount: number;
  pendingPrompt: string | null;
};

// Polls pollAction every ~2.5s while a run is RUNNING/AWAITING_INPUT
// (docs/03-ingestion-and-scrapers.md's real-time execution model) — a
// scraper run can pause indefinitely on a site's own verification screen,
// which no synchronous request/response could sensibly wait for. When
// AWAITING_INPUT, shows the scraper's own prompt text and a field to
// relay a human's answer (e.g. a 2FA code) into the still-running
// container via submitInputAction. Stops polling once a run reaches a
// terminal status — COMPLETED/FAILED/INTERRUPTED runs render as static
// history exactly like before this feature existed.
export function ScraperRunLive({
  run: initialRun,
  pollAction,
  submitInputAction,
}: {
  run: ScraperRunSummary;
  pollAction: (runId: string) => Promise<ScraperRunPollResult>;
  submitInputAction: (runId: string, text: string) => Promise<void>;
}) {
  const [run, setRun] = useState(initialRun);
  const [inputValue, setInputValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pollingRef = useRef(false);

  const isLive = run.status === "RUNNING" || run.status === "AWAITING_INPUT";

  useEffect(() => {
    if (!isLive) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      // A poll already in flight (e.g. a slow ai-service response) skips
      // this tick rather than piling up overlapping requests — Server
      // Actions dispatch sequentially per client anyway, but this avoids
      // queuing up a backlog of stale polls behind a slow one.
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const result = await pollAction(run.id);
        if (!cancelled) {
          setRun((prev) => ({
            ...prev,
            status: result.status,
            logOutput: result.logOutput,
            filesIngestedCount: result.filesIngestedCount,
            pendingPrompt: result.pendingPrompt,
            finishedAt:
              result.status === "RUNNING" || result.status === "AWAITING_INPUT"
                ? prev.finishedAt
                : new Date().toISOString(),
          }));
        }
      } catch {
        // A transient poll failure isn't fatal — just try again next tick.
      } finally {
        pollingRef.current = false;
      }
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when live-ness itself changes
  }, [isLive, run.id]);

  async function handleSubmitInput() {
    if (!inputValue.trim()) return;
    setSubmitting(true);
    try {
      await submitInputAction(run.id, inputValue.trim());
      setInputValue("");
      setRun((prev) => ({ ...prev, status: "RUNNING", pendingPrompt: null }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Badge
            variant={
              run.status === "COMPLETED"
                ? "default"
                : run.status === "RUNNING" || run.status === "AWAITING_INPUT"
                  ? "secondary"
                  : "destructive"
            }
          >
            {run.status.toLowerCase().replace("_", " ")}
          </Badge>
          <span className="text-muted-foreground text-xs font-normal">
            {new Date(run.startedAt).toLocaleString()}
            {run.finishedAt && ` – ${new Date(run.finishedAt).toLocaleString()}`}
          </span>
        </CardTitle>
        <CardDescription>
          {run.filesIngestedCount} file{run.filesIngestedCount === 1 ? "" : "s"} ingested
        </CardDescription>
      </CardHeader>
      {(run.status === "AWAITING_INPUT" || run.logOutput) && (
        <CardContent className="flex flex-col gap-3">
          {run.status === "AWAITING_INPUT" && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-sm font-medium">Input needed to continue</p>
              <p className="text-muted-foreground text-sm">{run.pendingPrompt}</p>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label htmlFor={`input-${run.id}`} className="sr-only">
                    Response
                  </Label>
                  <Input
                    id={`input-${run.id}`}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSubmitInput();
                    }}
                    autoComplete="off"
                    disabled={submitting}
                  />
                </div>
                <Button type="button" onClick={handleSubmitInput} disabled={submitting || !inputValue.trim()}>
                  {submitting ? "Sending…" : "Submit"}
                </Button>
              </div>
            </div>
          )}
          {run.logOutput && (
            <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
              {run.logOutput}
            </pre>
          )}
        </CardContent>
      )}
    </Card>
  );
}
