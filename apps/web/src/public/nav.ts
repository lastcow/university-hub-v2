export interface PublicNavItem {
  to: string;
  label: string;
}

export const PUBLIC_NAV: readonly PublicNavItem[] = [
  { to: "/", label: "Home" },
  { to: "/features", label: "Features" },
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
];
