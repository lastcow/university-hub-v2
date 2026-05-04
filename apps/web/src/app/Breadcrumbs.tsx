import { Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { NAV_SECTIONS } from "./nav";

interface Crumb {
  label: string;
  to?: string;
}

const STATIC_LABELS: Record<string, string> = {
  app: "Home",
  dashboard: "Dashboard",
  ux: "UX states",
  new: "New",
  edit: "Edit",
};

function flatNavLabel(path: string): string | undefined {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.to === path) return item.label;
    }
  }
  return undefined;
}

function humanize(segment: string): string {
  return segment
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  const crumbs: Crumb[] = [];
  let acc = "";
  for (const segment of segments) {
    acc += `/${segment}`;
    const fromNav = flatNavLabel(acc);
    const label =
      fromNav ?? STATIC_LABELS[segment] ?? humanize(decodeURIComponent(segment));
    crumbs.push({ label, to: acc });
  }

  // Last crumb is current page → don't link.
  const last = crumbs[crumbs.length - 1];
  if (last) delete last.to;

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-xs text-muted-foreground"
    >
      {crumbs.map((crumb, idx) => (
        <Fragment key={`${crumb.label}-${idx}`}>
          {idx > 0 ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          ) : null}
          {crumb.to ? (
            <Link
              to={crumb.to}
              className="rounded px-1 hover:text-foreground hover:underline"
            >
              {crumb.label}
            </Link>
          ) : (
            <span className="px-1 font-medium text-foreground">
              {crumb.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
