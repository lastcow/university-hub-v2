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

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";

import type {
  LmsConnectionPublic,
  LmsProviderId,
  LmsProviderRegistryEntry,
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
import { listLmsProviderConfigs } from "@/lib/lms-provider-configs";

interface IntegrationsState {
  status: "loading" | "ok" | "error";
  error?: string;
  providers: LmsProviderRegistryEntry[];
  connections: LmsConnectionPublic[];
}

const INITIAL_STATE: IntegrationsState = {
  status: "loading",
  providers: [],
  connections: [],
};

const CONSENT_STORAGE_PREFIX = "uh.lms.consent.acknowledged.v1.";

export function IntegrationsPage() {
  const { user } = useAuth();
  const [state, setState] = useState<IntegrationsState>(INITIAL_STATE);
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingProvider, setPendingProvider] = useState<LmsProviderId | null>(
    null,
  );
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentTarget, setConsentTarget] =
    useState<LmsProviderRegistryEntry | null>(null);
  const [consentAcknowledged, setConsentAcknowledged] = useState(false);

  const consentStorageKey = useMemo(
    () => (user ? `${CONSENT_STORAGE_PREFIX}${user.id}` : null),
    [user],
  );

  async function reload() {
    setState((prev) => ({ ...prev, status: "loading" }));
    try {
      const [providersRes, connectionsRes] = await Promise.all([
        listLmsProviderConfigs(),
        listLmsConnections(),
      ]);
      setState({
        status: "ok",
        providers: providersRes.providers,
        connections: connectionsRes.connections,
      });
    } catch (cause) {
      // The provider-configs listing requires an admin role; non-admin
      // users get a 403 there. That's fine — surface the connections
      // alone in that case.
      if (cause instanceof ApiClientError && cause.status === 403) {
        try {
          const connectionsRes = await listLmsConnections();
          setState({
            status: "ok",
            providers: [],
            connections: connectionsRes.connections,
          });
          return;
        } catch (innerCause) {
          setState({
            status: "error",
            providers: [],
            connections: [],
            error:
              innerCause instanceof ApiClientError
                ? innerCause.message
                : "Could not load your LMS connections.",
          });
          return;
        }
      }
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

  // Initial load.
  useEffect(() => {
    void reload();
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

  function openConsent(entry: LmsProviderRegistryEntry) {
    setConsentTarget(entry);
    setConsentAcknowledged(false);
    setConsentOpen(true);
  }

  async function performConnect(entry: LmsProviderRegistryEntry) {
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

  function onConnectClick(entry: LmsProviderRegistryEntry) {
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
    </div>
  );
}

interface VisibleProvider {
  entry: LmsProviderRegistryEntry;
  connection: LmsConnectionPublic | null;
}

function composeProviderList(
  providers: LmsProviderRegistryEntry[],
  connections: LmsConnectionPublic[],
): VisibleProvider[] {
  const enabled = providers.filter(
    (p) => p.config !== null && p.config.enabled,
  );
  const byProvider = new Map(enabled.map((p) => [p.provider_id, p]));
  // Add any provider the user has an active or expired connection for
  // even if the admin disabled it — they should still be able to
  // disconnect cleanly. Revoked connections without an enabled
  // provider are hidden (no useful action remains).
  const out: VisibleProvider[] = enabled.map((entry) => ({
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
        config: null,
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
}: {
  entry: LmsProviderRegistryEntry;
  connection: LmsConnectionPublic | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
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
          {connection
            ? connection.base_url
            : entry.config?.base_url ??
              "Connect your account to import your courses and enrolled students."}
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
                disabled
                aria-label="Sync now (available in the next release)"
                title="Sync UI ships with the next sub-issue"
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
              disabled={busy || entry.config === null || !entry.config.enabled}
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
  target: LmsProviderRegistryEntry | null;
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

