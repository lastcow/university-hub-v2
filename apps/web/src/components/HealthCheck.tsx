import { useEffect, useState } from "react";

import type { HealthResponse } from "@university-hub/shared";

import { ApiClientError, api } from "@/lib/api";

type State =
  | { status: "loading" }
  | { status: "ok"; data: HealthResponse }
  | { status: "error"; message: string };

export function HealthCheck() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<HealthResponse>("/api/health", { signal: controller.signal })
      .then((data) => setState({ status: "ok", data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof ApiClientError
            ? error.message
            : "Health check failed";
        setState({ status: "error", message });
      });
    return () => controller.abort();
  }, []);

  if (state.status === "loading") {
    return (
      <p className="text-sm text-muted-foreground">Checking worker health…</p>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-sm text-destructive">Worker unreachable: {state.message}</p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      Worker <span className="font-mono">{state.data.service}</span> is up at{" "}
      <time dateTime={state.data.timestamp}>{state.data.timestamp}</time>.
    </p>
  );
}
