import { Link } from "react-router-dom";

import { PUBLIC_NAV } from "./nav";

export function PublicFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 text-sm md:flex-row md:items-start md:justify-between lg:px-6">
        <div className="max-w-sm space-y-2">
          <Link
            to="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <span
              aria-hidden
              className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
            >
              U
            </span>
            University Hub
          </Link>
          <p className="text-muted-foreground">
            A modern, invitation-only platform for managing universities,
            programs, and people.
          </p>
        </div>

        <nav aria-label="Footer">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Product
          </h2>
          <ul className="mt-3 space-y-2">
            {PUBLIC_NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="text-foreground hover:text-primary"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Account">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Account
          </h2>
          <ul className="mt-3 space-y-2">
            <li>
              <Link to="/sign-in" className="text-foreground hover:text-primary">
                Sign in
              </Link>
            </li>
            <li>
              <Link
                to="/accept-invitation"
                className="text-foreground hover:text-primary"
              >
                Accept invitation
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-6">
          <p>&copy; {year} University Hub. All rights reserved.</p>
          <p>Built on Cloudflare.</p>
        </div>
      </div>
    </footer>
  );
}
