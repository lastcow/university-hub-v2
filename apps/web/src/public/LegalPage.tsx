// Public-page renderer for /privacy and /terms (UNI-34).
//
// Shared component — the exact route mounts a thin wrapper that picks
// the kind ("terms" | "privacy"). The kind drives the heading + the
// fetch; everything else is identical (full-width card, version label,
// markdown body, "FERPA inquiries" mailto, last-updated timestamp).

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  LEGAL_DOCUMENT_KIND_LABELS,
  type LegalDocument,
  type LegalDocumentKind,
} from "@university-hub/shared";

import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError } from "@/lib/api";
import { getLegalDocument } from "@/lib/legal";
import { MarkdownView } from "@/lib/markdown";

interface LegalPageProps {
  kind: LegalDocumentKind;
}

interface State {
  status: "loading" | "ok" | "error";
  data?: LegalDocument;
  error?: string;
}

export function LegalPage({ kind }: LegalPageProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [params] = useSearchParams();
  // Optional invitation token: when this page is opened from the accept-
  // invitation link the token scopes the document to the inviting
  // university so the visitor sees their customer's text rather than
  // the global default.
  const token = params.get("token");
  const universityId = params.get("university_id");

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    getLegalDocument(
      kind,
      { token, university_id: universityId },
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load this document. Please try again later.",
        });
      });
    return () => controller.abort();
  }, [kind, token, universityId]);

  const otherKind: LegalDocumentKind = kind === "terms" ? "privacy" : "terms";

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 lg:px-6">
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {LEGAL_DOCUMENT_KIND_LABELS[kind]}
        </h1>
        {state.data ? (
          <p className="text-xs text-muted-foreground">
            Version {state.data.version} · Published{" "}
            {new Date(state.data.published_at).toLocaleDateString(undefined, {
              dateStyle: "long",
            })}
            {state.data.university_name
              ? ` · For ${state.data.university_name}`
              : ""}
            {state.data.source === "default"
              ? " · Default boilerplate"
              : ""}
          </p>
        ) : null}
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm md:p-8">
        {state.status === "loading" ? (
          <div className="space-y-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load this document"
            description={state.error}
          />
        ) : state.data ? (
          <MarkdownView source={state.data.body_md} />
        ) : null}
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        See also our{" "}
        <Link
          to={`/${otherKind === "terms" ? "terms" : "privacy"}`}
          className="underline underline-offset-2 hover:text-primary"
        >
          {LEGAL_DOCUMENT_KIND_LABELS[otherKind]}
        </Link>
        .
      </p>
    </div>
  );
}

export function PrivacyPage() {
  return <LegalPage kind="privacy" />;
}

export function TermsPage() {
  return <LegalPage kind="terms" />;
}
