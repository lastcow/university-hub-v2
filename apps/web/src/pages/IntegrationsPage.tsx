// /app/integrations — user-facing LMS connect surface (UNI-54).
//
// Any authenticated user can land here, but the Connect button only does
// something useful when:
//   1. Their university's admin has enabled the provider in Settings →
//      Integrations (UNI-53), AND
//   2. They haven't already connected (or their connection was revoked).
//
// FERPA consent: the first time a user clicks Connect we show a modal
// explaining what's imported, where it goes, and how to revoke. We
// remember acknowledgment in `localStorage` keyed per-user so the modal
// doesn't return on every connect attempt — and so a different user
// signing in on the same browser still sees it once. This is a UX
// nicety; the backend audit log + lms.connected row are the system of
// record for "this user agreed to the disclosure".

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";

import type {
  LmsConnectionPublic,
  LmsConnectionTerm,
  LmsEnabledProvider,
  LmsProviderId,
  LmsSyncPreviewResponse,
  LmsSyncRunPublic,
  LmsSyncRunStatus,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import {
  disconnectLmsConnection,
  listLmsConnections,
  startCanvasConnection,
} from "@/lib/lms-connections";
import { listEnabledLmsProviders } from "@/lib/lms-provider-configs";
import {
  createLmsSyncRun,
  getLmsSyncRun,
  listLmsConnectionTerms,
  listLmsSyncRuns,
  previewLmsSyncRun,
} from "@/lib/lms-sync-runs";

interface IntegrationsState {
  status: "loading" | "ok" | "error";
  error?: string;
  providers: LmsEnabledProvider[];
  connections: LmsConnectionPublic[];
}

const INITIAL_STATE: IntegrationsState = {
  status: "loading",
  providers: [],
  connections: [],
};

const CONSENT_STORAGE_PREFIX = "uh.lms.consent.acknowledged.v1.";
const SYNC_POLL_INTERVAL_MS = 2_000;
const SYNC_HISTORY_DISPLAY_LIMIT = 10;
const TERMINAL_SYNC_STATUSES: ReadonlyArray<LmsSyncRunStatus> = [
  "success",
  "partial",
  "failed",
];

export function IntegrationsPage() {
  const { user } = useAuth();
  const [state, setState] = useState<IntegrationsState>(INITIAL_STATE);
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingProvider, setPendingProvider] = useState<LmsProviderId | null>(
    null,
  );
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentTarget, setConsentTarget] =
    useState<LmsEnabledProvider | null>(null);
  const [consentAcknowledged, setConsentAcknowledged] = useState(false);
  const [syncTarget, setSyncTarget] = useState<LmsConnectionPublic | null>(
    null,
  );
  const [historyState, setHistoryState] = useState<SyncHistoryState>(
    INITIAL_HISTORY_STATE,
  );

  const consentStorageKey = useMemo(
    () => (user ? `${CONSENT_STORAGE_PREFIX}${user.id}` : null),
    [user],
  );

  async function reload() {
    setState((prev) => ({ ...prev, status: "loading" }));
    try {
      // Both endpoints are reachable for any authenticated user. The
      // enabled-providers listing is the public, non-admin view of the
      // admin-managed `lms_provider_configs` table — it returns only
      // enabled rows for the caller's university, with no admin-only
      // fields (`client_id_last4`, `has_client_secret`, etc.).
      const [providersRes, connectionsRes] = await Promise.all([
        listEnabledLmsProviders(),
        listLmsConnections(),
      ]);
      setState({
        status: "ok",
        providers: providersRes.providers,
        connections: connectionsRes.connections,
      });
    } catch (cause) {
      setState({
        status: "error",
        providers: [],
        connections: [],
        error:
          cause instanceof ApiClientError
            ? cause.message
            : "Could not load your LMS connections.",
      });
    }
  }

  async function reloadHistory() {
    setHistoryState((prev) => ({ ...prev, status: "loading" }));
    try {
      const res = await listLmsSyncRuns();
      setHistoryState({
        status: "ok",
        runs: res.sync_runs.slice(0, SYNC_HISTORY_DISPLAY_LIMIT),
      });
    } catch (cause) {
      setHistoryState({
        status: "error",
        runs: [],
        error:
          cause instanceof ApiClientError
            ? cause.message
            : "Could not load sync history.",
      });
    }
  }

  // Initial load.
  useEffect(() => {
    void reload();
    void reloadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface the post-OAuth-callback toast and strip the query param so
  // a refresh doesn't re-trigger the toast.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const lmsError = searchParams.get("lms_error");
    if (connected) {
      toast({
        title: "Canvas connected",
        description: "Your Canvas account is now linked. You can sync from this page.",
        variant: "success",
      });
      const next = new URLSearchParams(searchParams);
      next.delete("connected");
      setSearchParams(next, { replace: true });
      void reload();
    } else if (lmsError) {
      toast({
        title: "Couldn't finish connecting",
        description:
          searchParams.get("detail") ||
          "Canvas didn't complete the connection. Please try again.",
        variant: "destructive",
      });
      const next = new URLSearchParams(searchParams);
      next.delete("lms_error");
      next.delete("detail");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isConsentAcknowledged(): boolean {
    if (!consentStorageKey) return false;
    try {
      return localStorage.getItem(consentStorageKey) === "1";
    } catch {
      return false;
    }
  }

  function rememberConsent() {
    if (!consentStorageKey) return;
    try {
      localStorage.setItem(consentStorageKey, "1");
    } catch {
      // localStorage may be unavailable (private mode, quota); that's
      // OK — the worst case is the user sees the modal again next session.
    }
  }

  function openConsent(entry: LmsEnabledProvider) {
    setConsentTarget(entry);
    setConsentAcknowledged(false);
    setConsentOpen(true);
  }

  async function performConnect(entry: LmsEnabledProvider) {
    setPendingProvider(entry.provider_id);
    try {
      const res = await startCanvasConnection({
        purpose: `University Hub for ${entry.display_name} sync`,
      });
      window.location.href = res.authorize_url;
    } catch (cause) {
      setPendingProvider(null);
      toast({
        title: "Couldn't start the Canvas connect flow",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    }
  }

  function onConnectClick(entry: LmsEnabledProvider) {
    if (isConsentAcknowledged()) {
      void performConnect(entry);
      return;
    }
    openConsent(entry);
  }

  function onConsentConfirm() {
    if (!consentAcknowledged || !consentTarget) return;
    rememberConsent();
    setConsentOpen(false);
    const target = consentTarget;
    setConsentTarget(null);
    void performConnect(target);
  }

  async function onDisconnect(connection: LmsConnectionPublic) {
    if (
      !window.confirm(
        "Disconnect this LMS account? Your stored credentials will be cleared and future syncs will stop until you reconnect.",
      )
    ) {
      return;
    }
    setPendingProvider(connection.provider_id);
    try {
      await disconnectLmsConnection(connection.id);
      toast({
        title: "LMS account disconnected",
        variant: "success",
      });
      await reload();
    } catch (cause) {
      toast({
        title: "Couldn't disconnect",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPendingProvider(null);
    }
  }

  // Visible providers: prefer the admin's enabled set, but always show
  // any provider the user has an active connection for so they can
  // disconnect even after the admin disabled the provider.
  const visibleProviders = useMemo(() => {
    return composeProviderList(state.providers, state.connections);
  }, [state.providers, state.connections]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          LMS integrations
        </h1>
        <p className="text-sm text-muted-foreground">
          Connect your Learning Management System (LMS) account to import
          your courses and enrolled students into University Hub.
        </p>
      </header>

      {state.status === "loading" ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load your integrations"
          description={state.error}
        />
      ) : visibleProviders.length === 0 ? (
        <NoProvidersCard />
      ) : (
        <div className="space-y-4">
          {visibleProviders.map(({ entry, connection }) => (
            <ProviderConnectCard
              key={entry.provider_id}
              entry={entry}
              connection={connection}
              busy={pendingProvider === entry.provider_id}
              onConnect={() => onConnectClick(entry)}
              onDisconnect={() => connection && onDisconnect(connection)}
              onSyncNow={() => connection && setSyncTarget(connection)}
            />
          ))}
        </div>
      )}

      <ConsentModal
        open={consentOpen}
        target={consentTarget}
        acknowledged={consentAcknowledged}
        onAcknowledgedChange={setConsentAcknowledged}
        onConfirm={onConsentConfirm}
        onCancel={() => {
          setConsentOpen(false);
          setConsentTarget(null);
        }}
      />

      <SyncRunModal
        connection={syncTarget}
        onClose={(opts) => {
          setSyncTarget(null);
          if (opts?.refreshHistory) {
            void reloadHistory();
            void reload();
          }
        }}
      />

      <SyncHistorySection
        state={historyState}
        connections={state.connections}
        onRefresh={() => void reloadHistory()}
      />
    </div>
  );
}

interface VisibleProvider {
  entry: LmsEnabledProvider;
  connection: LmsConnectionPublic | null;
}

function composeProviderList(
  providers: LmsEnabledProvider[],
  connections: LmsConnectionPublic[],
): VisibleProvider[] {
  const byProvider = new Map(providers.map((p) => [p.provider_id, p]));
  // Add any provider the user has an active or expired connection for
  // even if the admin disabled it — they should still be able to
  // disconnect cleanly. Revoked connections without an enabled
  // provider are hidden (no useful action remains).
  const out: VisibleProvider[] = providers.map((entry) => ({
    entry,
    connection:
      connections.find(
        (c) => c.provider_id === entry.provider_id && c.status !== "revoked",
      ) ?? null,
  }));
  for (const conn of connections) {
    if (conn.status === "revoked") continue;
    if (byProvider.has(conn.provider_id)) continue;
    out.push({
      entry: {
        provider_id: conn.provider_id,
        display_name: humanizeProviderId(conn.provider_id),
        base_url: conn.base_url,
      },
      connection: conn,
    });
  }
  return out;
}

function humanizeProviderId(id: LmsProviderId): string {
  switch (id) {
    case "canvas":
      return "Canvas";
    case "blackboard":
      return "Blackboard";
    case "moodle":
      return "Moodle";
    case "google_classroom":
      return "Google Classroom";
  }
}

function NoProvidersCard() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
          <CardTitle>No LMS integrations available yet</CardTitle>
        </div>
        <CardDescription>
          Your university has not enabled any LMS providers yet. Once an
          administrator configures Canvas (or another supported LMS) in
          Settings → Integrations, the connect option will appear here.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function ProviderConnectCard({
  entry,
  connection,
  busy,
  onConnect,
  onDisconnect,
  onSyncNow,
}: {
  entry: LmsEnabledProvider;
  connection: LmsConnectionPublic | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onSyncNow: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{entry.display_name}</CardTitle>
            <ConnectionBadge connection={connection} />
          </div>
        </div>
        <CardDescription>
          {connection ? connection.base_url : entry.base_url}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connection ? (
          <ConnectedState connection={connection} />
        ) : (
          <p className="text-sm text-muted-foreground">
            We'll redirect you to {entry.display_name} to authorize University
            Hub. You can revoke this connection at any time from this page.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {connection ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSyncNow}
                disabled={busy || connection?.status !== "active"}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Sync now
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onDisconnect}
                disabled={busy}
              >
                <Unplug className="mr-2 h-4 w-4" />
                {busy ? "Disconnecting…" : "Disconnect"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={onConnect}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              {busy
                ? "Redirecting…"
                : `Connect ${entry.display_name}`}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectionBadge({
  connection,
}: {
  connection: LmsConnectionPublic | null;
}) {
  if (!connection) {
    return <Badge variant="outline">Not connected</Badge>;
  }
  if (connection.status === "active") {
    return <Badge variant="success">Connected</Badge>;
  }
  if (connection.status === "expired") {
    return <Badge variant="warning">Expired</Badge>;
  }
  return <Badge variant="secondary">Revoked</Badge>;
}

function ConnectedState({ connection }: { connection: LmsConnectionPublic }) {
  return (
    <dl className="grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-2">
      <div>
        <dt className="font-medium text-foreground">Auth method</dt>
        <dd>{connection.auth_method === "pat" ? "Personal Access Token" : "OAuth"}</dd>
      </div>
      <div>
        <dt className="font-medium text-foreground">Last synced</dt>
        <dd>
          {connection.last_synced_at
            ? formatRelative(connection.last_synced_at)
            : "Never"}
        </dd>
      </div>
    </dl>
  );
}

function ConsentModal({
  open,
  target,
  acknowledged,
  onAcknowledgedChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  target: LmsEnabledProvider | null;
  acknowledged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <DialogTitle>
              Connect{target ? ` ${target.display_name}` : " your LMS"} to University Hub
            </DialogTitle>
          </div>
          <DialogDescription>
            Before you authorize, please review what University Hub will read
            from {target?.display_name ?? "your LMS"} and how that data is
            handled. This disclosure complies with FERPA's record-of-access
            requirements.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <section>
            <h3 className="font-semibold text-foreground">What we import</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                Your courses for the term you select (course code, name,
                description).
              </li>
              <li>
                Enrollments in those courses — students, teachers, and
                teacher-assistants.
              </li>
              <li>
                Basic profile fields for those people: name, email,
                LMS-assigned ID. We do not import grades, assignments, or
                course content.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-foreground">Where it goes</h3>
            <p className="text-muted-foreground">
              Imported data is stored in this University Hub instance only.
              It is not shared with any third party and is scoped to your
              university tenant.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-foreground">How to revoke</h3>
            <p className="text-muted-foreground">
              You can disconnect at any time from this page. We immediately
              clear the stored access tokens; your imported rows remain so
              that grades and analytics continue to work, but no further
              syncs run until you reconnect.
            </p>
          </section>
        </div>

        <label
          htmlFor="lms-consent-ack"
          className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm"
        >
          <input
            id="lms-consent-ack"
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-input"
            checked={acknowledged}
            onChange={(event) => onAcknowledgedChange(event.target.checked)}
          />
          <span>
            I understand what data University Hub will import from{" "}
            {target?.display_name ?? "my LMS"} and how to revoke this
            connection.
          </span>
        </label>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!acknowledged}
            onClick={onConfirm}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Continue to {target?.display_name ?? "LMS"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const deltaMs = Date.now() - then;
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} mo ago`;
  const years = Math.round(days / 365);
  return `${years} y ago`;
}

// ---------------------------------------------------------------------------
// Sync Now modal — drives the four-step flow: pick term → preview →
// confirm → progress → completion. The modal owns its own polling loop;
// the parent only knows whether it's open and gets a callback when the
// run reaches a terminal state so the history table can refresh.
// ---------------------------------------------------------------------------

type SyncStep = "picking" | "previewing" | "confirming" | "running" | "done";

interface SyncRunModalState {
  step: SyncStep;
  terms: LmsConnectionTerm[];
  selectedTermId: string | null;
  termsError: string | null;
  preview: LmsSyncPreviewResponse | null;
  previewError: string | null;
  syncRun: LmsSyncRunPublic | null;
  runError: string | null;
}

const INITIAL_SYNC_MODAL_STATE: SyncRunModalState = {
  step: "picking",
  terms: [],
  selectedTermId: null,
  termsError: null,
  preview: null,
  previewError: null,
  syncRun: null,
  runError: null,
};

function SyncRunModal({
  connection,
  onClose,
}: {
  connection: LmsConnectionPublic | null;
  onClose: (opts?: { refreshHistory?: boolean }) => void;
}) {
  const open = connection !== null;
  const [modal, setModal] = useState<SyncRunModalState>(
    INITIAL_SYNC_MODAL_STATE,
  );
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reachedTerminalRef = useRef(false);

  // Reset state and load terms whenever a new connection target arrives.
  useEffect(() => {
    if (!connection) return;
    setModal({ ...INITIAL_SYNC_MODAL_STATE, step: "picking" });
    reachedTerminalRef.current = false;
    let cancelled = false;
    void (async () => {
      try {
        const res = await listLmsConnectionTerms(connection.id);
        if (cancelled) return;
        setModal((prev) => ({
          ...prev,
          terms: res.terms,
          selectedTermId:
            res.terms.length > 0 ? (res.terms[0]?.external_id ?? null) : null,
          termsError: null,
        }));
      } catch (cause) {
        if (cancelled) return;
        setModal((prev) => ({
          ...prev,
          termsError:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load terms from your LMS.",
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  // Halt polling when the modal closes or the run hits a terminal status.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  function stopPolling() {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  async function pollOnce(syncRunId: string) {
    try {
      const res = await getLmsSyncRun(syncRunId);
      const next = res.sync_run;
      setModal((prev) => ({ ...prev, syncRun: next, runError: null }));
      if (TERMINAL_SYNC_STATUSES.includes(next.status)) {
        // Polling halts on terminal status — this is the criterion the
        // issue calls out explicitly. We also flip the step into "done"
        // so the modal renders the completion summary instead of the
        // progress spinner.
        reachedTerminalRef.current = true;
        stopPolling();
        setModal((prev) => ({ ...prev, step: "done" }));
        return;
      }
      pollTimerRef.current = setTimeout(
        () => void pollOnce(syncRunId),
        SYNC_POLL_INTERVAL_MS,
      );
    } catch (cause) {
      stopPolling();
      setModal((prev) => ({
        ...prev,
        runError:
          cause instanceof ApiClientError
            ? cause.message
            : "Lost contact with the sync run. Refresh and try again.",
      }));
    }
  }

  async function onPreviewClick() {
    if (!connection || !modal.selectedTermId) return;
    setModal((prev) => ({
      ...prev,
      step: "previewing",
      preview: null,
      previewError: null,
    }));
    try {
      const res = await previewLmsSyncRun({
        connection_id: connection.id,
        term_id: modal.selectedTermId,
      });
      setModal((prev) => ({
        ...prev,
        step: "confirming",
        preview: res,
      }));
    } catch (cause) {
      setModal((prev) => ({
        ...prev,
        step: "picking",
        previewError:
          cause instanceof ApiClientError
            ? cause.message
            : "Could not preview the import.",
      }));
    }
  }

  async function onConfirmClick() {
    if (!connection || !modal.selectedTermId) return;
    setModal((prev) => ({
      ...prev,
      step: "running",
      syncRun: null,
      runError: null,
    }));
    try {
      const created = await createLmsSyncRun({
        connection_id: connection.id,
        term_id: modal.selectedTermId,
      });
      // First fetch right away, then poll. Cloudflare's executionCtx
      // hasn't necessarily moved the row past `pending` by the time the
      // 202 response comes back; the first fetch and subsequent polls
      // are what surface the transition.
      void pollOnce(created.sync_run_id);
    } catch (cause) {
      setModal((prev) => ({
        ...prev,
        step: "confirming",
        runError:
          cause instanceof ApiClientError
            ? cause.message
            : "Could not start the sync run.",
      }));
    }
  }

  function handleClose() {
    stopPolling();
    const refreshHistory = reachedTerminalRef.current;
    setModal(INITIAL_SYNC_MODAL_STATE);
    reachedTerminalRef.current = false;
    onClose({ refreshHistory });
  }

  if (!connection) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            <DialogTitle>Sync from {connection.base_url}</DialogTitle>
          </div>
          <DialogDescription>
            Pick a term, review the import, and run the sync. Progress will
            update automatically.
          </DialogDescription>
        </DialogHeader>

        {modal.step === "picking" || modal.step === "previewing" ? (
          <SyncTermPickerStep
            modal={modal}
            onSelect={(termId) =>
              setModal((prev) => ({ ...prev, selectedTermId: termId }))
            }
          />
        ) : null}

        {modal.step === "confirming" && modal.preview ? (
          <SyncPreviewStep preview={modal.preview} runError={modal.runError} />
        ) : null}

        {modal.step === "running" ? (
          <SyncProgressStep syncRun={modal.syncRun} runError={modal.runError} />
        ) : null}

        {modal.step === "done" && modal.syncRun ? (
          <SyncDoneStep syncRun={modal.syncRun} />
        ) : null}

        <DialogFooter>
          {modal.step === "picking" || modal.step === "previewing" ? (
            <>
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={onPreviewClick}
                disabled={
                  !modal.selectedTermId || modal.step === "previewing"
                }
              >
                {modal.step === "previewing" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Preview import
              </Button>
            </>
          ) : null}

          {modal.step === "confirming" ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setModal((prev) => ({ ...prev, step: "picking" }))
                }
              >
                Back
              </Button>
              <Button type="button" onClick={onConfirmClick}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Start sync
              </Button>
            </>
          ) : null}

          {modal.step === "running" ? (
            <Button type="button" variant="outline" onClick={handleClose}>
              Hide (continues in background)
            </Button>
          ) : null}

          {modal.step === "done" ? (
            <Button type="button" onClick={handleClose}>
              Close
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SyncTermPickerStep({
  modal,
  onSelect,
}: {
  modal: SyncRunModalState;
  onSelect: (termId: string) => void;
}) {
  if (modal.termsError) {
    return (
      <ErrorState
        title="Couldn't load terms"
        description={modal.termsError}
      />
    );
  }
  if (modal.terms.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading terms from your LMS…
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {modal.previewError ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {modal.previewError}
        </p>
      ) : null}
      <label className="block text-sm font-medium" htmlFor="lms-sync-term">
        Term
      </label>
      <select
        id="lms-sync-term"
        className="w-full rounded-md border bg-background p-2 text-sm"
        value={modal.selectedTermId ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        {modal.terms.map((t) => (
          <option key={t.external_id} value={t.external_id}>
            {t.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        We'll only import data for the term you select.
      </p>
    </div>
  );
}

function SyncPreviewStep({
  preview,
  runError,
}: {
  preview: LmsSyncPreviewResponse;
  runError: string | null;
}) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        This will import{" "}
        <strong className="text-foreground">{preview.courses}</strong> course
        {preview.courses === 1 ? "" : "s"} and{" "}
        <strong className="text-foreground">
          {preview.truncated ? "~" : ""}
          {preview.students_total}
        </strong>{" "}
        student{preview.students_total === 1 ? "" : "s"}
        {preview.term_name ? <> from <strong className="text-foreground">{preview.term_name}</strong></> : null}.
      </p>
      <dl className="grid grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3">
        <PreviewStat label="Courses (new)">
          {preview.courses_new_estimate}
          {preview.courses > 0 ? ` of ${preview.courses}` : ""}
        </PreviewStat>
        <PreviewStat label="Students (new, est.)">
          {preview.students_new_estimate}
          {preview.students_total > 0
            ? ` of ${preview.students_total}`
            : ""}
        </PreviewStat>
      </dl>
      {preview.truncated ? (
        <p className="flex items-start gap-2 rounded-md bg-amber-100/60 p-3 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          One or more courses' enrollment lists could not be fetched in
          full for the preview. Counts shown are estimates; the sync run
          itself will still pull the complete list.
        </p>
      ) : null}
      {runError ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {runError}
        </p>
      ) : null}
    </div>
  );
}

function PreviewStat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold">{children}</dd>
    </div>
  );
}

function SyncProgressStep({
  syncRun,
  runError,
}: {
  syncRun: LmsSyncRunPublic | null;
  runError: string | null;
}) {
  if (runError) {
    return (
      <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        {runError}
      </p>
    );
  }
  if (!syncRun) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Starting sync…
      </p>
    );
  }
  const progress = syncRun.progress;
  const pct = progress
    ? Math.min(
        100,
        Math.round(
          (progress.current_step / Math.max(1, progress.total_steps)) * 100,
        ),
      )
    : 0;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          Status: <strong className="text-foreground">{syncRun.status}</strong>
        </span>
      </div>
      {progress ? (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Step {progress.current_step} of {progress.total_steps}
            {progress.label ? ` — ${progress.label}` : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SyncDoneStep({ syncRun }: { syncRun: LmsSyncRunPublic }) {
  const summary = syncRun.summary;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <SyncStatusBadge status={syncRun.status} />
        <span className="text-muted-foreground">
          Completed{" "}
          {syncRun.completed_at ? formatRelative(syncRun.completed_at) : "now"}
        </span>
      </div>
      {syncRun.errors && syncRun.errors.length > 0 ? (
        <div className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
          <p className="font-medium">
            {syncRun.errors.length} issue
            {syncRun.errors.length === 1 ? "" : "s"} reported during the run.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {syncRun.errors.slice(0, 3).map((err, i) => (
              <li key={i}>
                <span className="font-mono text-[10px] uppercase">
                  {err.scope}
                </span>{" "}
                {err.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary ? (
        <dl className="grid grid-cols-3 gap-3 rounded-md border bg-muted/30 p-3">
          <PreviewStat label="Courses created">{summary.courses_created}</PreviewStat>
          <PreviewStat label="Courses updated">{summary.courses_updated}</PreviewStat>
          <PreviewStat label="Courses unchanged">{summary.courses_unchanged}</PreviewStat>
          <PreviewStat label="Students created">{summary.students_created}</PreviewStat>
          <PreviewStat label="Students matched">{summary.students_matched}</PreviewStat>
          <PreviewStat label="Students invited">{summary.students_invited}</PreviewStat>
          <PreviewStat label="Enrollments created">{summary.enrollments_created}</PreviewStat>
          <PreviewStat label="Enrollments updated">{summary.enrollments_updated}</PreviewStat>
          <PreviewStat label="Enrollments unchanged">{summary.enrollments_unchanged}</PreviewStat>
        </dl>
      ) : null}
    </div>
  );
}

function SyncStatusBadge({ status }: { status: LmsSyncRunStatus }) {
  switch (status) {
    case "pending":
      return <Badge variant="outline">Pending</Badge>;
    case "running":
      return <Badge variant="secondary">Running</Badge>;
    case "success":
      return <Badge variant="success">Success</Badge>;
    case "partial":
      return <Badge variant="warning">Partial</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Sync history table — caller's last 5–10 runs.
// ---------------------------------------------------------------------------

interface SyncHistoryState {
  status: "loading" | "ok" | "error";
  runs: LmsSyncRunPublic[];
  error?: string;
}

const INITIAL_HISTORY_STATE: SyncHistoryState = {
  status: "loading",
  runs: [],
};

function SyncHistorySection({
  state,
  connections,
  onRefresh,
}: {
  state: SyncHistoryState;
  connections: LmsConnectionPublic[];
  onRefresh: () => void;
}) {
  const providerByConnection = useMemo(() => {
    const map = new Map<string, LmsProviderId>();
    for (const c of connections) map.set(c.id, c.provider_id);
    return map;
  }, [connections]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">Recent sync runs</CardTitle>
            <CardDescription>
              Last {SYNC_HISTORY_DISPLAY_LIMIT} runs, newest first.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={state.status === "loading"}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {state.status === "loading" ? (
          <Skeleton className="h-24 w-full" />
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load sync history"
            description={state.error}
          />
        ) : state.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sync runs yet. Click <strong>Sync now</strong> on a connected
            provider above to start your first import.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Term</th>
                <th className="pb-2 font-medium">Provider</th>
                <th className="pb-2 font-medium">Started</th>
                <th className="pb-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {state.runs.map((run) => (
                <tr key={run.id} className="border-t">
                  <td className="py-2">
                    <SyncStatusBadge status={run.status} />
                  </td>
                  <td className="py-2 text-foreground">
                    {run.term_name ?? run.term_id ?? "—"}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {humanizeProviderId(
                      providerByConnection.get(run.connection_id) ?? "canvas",
                    )}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {formatRelative(run.started_at)}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {summarizeRun(run)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function summarizeRun(run: LmsSyncRunPublic): string {
  if (run.status === "running" || run.status === "pending") {
    if (run.progress) {
      return `Step ${run.progress.current_step}/${run.progress.total_steps}${
        run.progress.label ? ` — ${run.progress.label}` : ""
      }`;
    }
    return "In progress";
  }
  if (run.status === "failed") {
    return run.errors && run.errors.length > 0
      ? run.errors[0]?.message ?? "Failed"
      : "Failed";
  }
  if (run.summary) {
    const courses = run.summary.courses_created + run.summary.courses_updated;
    const students =
      run.summary.students_created + run.summary.students_matched;
    return `${courses} courses, ${students} students`;
  }
  return "—";
}

