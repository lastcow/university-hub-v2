// In-app re-acceptance gate (UNI-34).
//
// Mounted inside `AppShell` for every authenticated route. On mount we
// poll `/api/legal/acknowledgment-status`; when `terms_required` is
// true (because the user has never accepted, or because an admin
// bumped the ToS version since their last accept) we render a modal
// that blocks the rest of the app until the user reads + agrees.
//
// The modal renders the actual ToS body in a scrollable region so the
// agreement is meaningful — accepting without scrolling is technically
// possible (we don't gate the button on scroll) but the user has to
// pass through the document to find the checkbox below it. That's the
// same posture used during the invitation accept flow.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  type LegalAcknowledgmentStatus,
  type LegalDocument,
} from "@university-hub/shared";

import { Button } from "@/components/ui/button";
import { ApiClientError } from "@/lib/api";
import {
  acceptLegal,
  getAcknowledgmentStatus,
  getLegalDocument,
} from "@/lib/legal";
import { MarkdownView } from "@/lib/markdown";

interface DocsState {
  terms?: LegalDocument;
  privacy?: LegalDocument;
}

export function LegalAcknowledgmentGate() {
  const [status, setStatus] = useState<LegalAcknowledgmentStatus | null>(null);
  const [docs, setDocs] = useState<DocsState>({});
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getAcknowledgmentStatus(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setStatus(data);
      })
      .catch(() => {
        // Best-effort; the gate stays closed if the fetch fails so
        // a transient network blip doesn't lock the user out.
        if (controller.signal.aborted) return;
        setStatus(null);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!status?.terms_required) return;
    const controller = new AbortController();
    Promise.all([
      getLegalDocument("terms", {}, controller.signal),
      getLegalDocument("privacy", {}, controller.signal),
    ])
      .then(([terms, privacy]) => {
        if (controller.signal.aborted) return;
        setDocs({ terms, privacy });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Could not load the latest Terms or Privacy Policy.");
      });
    return () => controller.abort();
  }, [status?.terms_required]);

  if (!status?.terms_required) return null;

  async function onAccept() {
    if (!status || !docs.terms || !docs.privacy) return;
    setError(null);
    setSubmitting(true);
    try {
      await acceptLegal({
        terms_version: docs.terms.version,
        privacy_version: docs.privacy.version,
      });
      setStatus({
        ...status,
        terms_required: false,
        accepted_terms_version: docs.terms.version,
      });
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : "Could not record your acceptance. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-gate-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur"
    >
      <div className="flex h-full max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
        <div className="border-b px-6 py-4">
          <h2
            id="legal-gate-title"
            className="text-lg font-semibold tracking-tight"
          >
            Please review the updated Terms &amp; Privacy Policy
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {status.accepted_terms_version === null
              ? "Your account hasn't recorded an acceptance yet — review the documents below to continue."
              : `The Terms have been updated since you last accepted (you accepted v${status.accepted_terms_version}; current is v${status.current_terms_version}).`}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {docs.terms && docs.privacy ? (
            <div className="space-y-8">
              <section>
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Terms of Service · v{docs.terms.version}
                </p>
                <MarkdownView source={docs.terms.body_md} />
              </section>
              <section>
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Privacy Policy · v{docs.privacy.version}
                </p>
                <MarkdownView source={docs.privacy.body_md} />
              </section>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Loading the latest versions…
            </p>
          )}
        </div>

        <div className="space-y-3 border-t px-6 py-4">
          <label
            htmlFor="legal-gate-accept"
            className="flex items-start gap-3 text-sm"
          >
            <input
              id="legal-gate-accept"
              type="checkbox"
              checked={agreeChecked}
              onChange={(e) => setAgreeChecked(e.target.checked)}
              disabled={submitting}
              className="mt-1 h-4 w-4 shrink-0 rounded border-input text-primary focus:ring-2 focus:ring-ring focus:ring-offset-0"
            />
            <span className="leading-snug">
              I have read and agree to the updated{" "}
              <Link
                to="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-2 hover:text-primary"
              >
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link
                to="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-2 hover:text-primary"
              >
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              onClick={onAccept}
              disabled={!agreeChecked || submitting || !docs.terms}
            >
              {submitting ? "Saving…" : "I agree — continue"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
