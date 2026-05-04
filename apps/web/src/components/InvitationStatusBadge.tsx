import type { EmailLogStatus, InvitationStatus } from "@university-hub/shared";

import { Badge, type BadgeProps } from "@/components/ui/badge";

const STATUS_LABELS: Record<InvitationStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_VARIANTS: Record<InvitationStatus, BadgeProps["variant"]> = {
  pending: "warning",
  accepted: "success",
  expired: "outline",
  revoked: "destructive",
};

export function InvitationStatusBadge({ status }: { status: InvitationStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}

const EMAIL_LABELS: Record<EmailLogStatus, string> = {
  sent: "Email sent",
  failed: "Email failed",
  pending: "Email pending",
};

const EMAIL_VARIANTS: Record<EmailLogStatus, BadgeProps["variant"]> = {
  sent: "success",
  failed: "destructive",
  pending: "warning",
};

export function EmailDeliveryBadge({ status }: { status: EmailLogStatus | null }) {
  if (!status) return <Badge variant="outline">Not sent</Badge>;
  return <Badge variant={EMAIL_VARIANTS[status]}>{EMAIL_LABELS[status]}</Badge>;
}
