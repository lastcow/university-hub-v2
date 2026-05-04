import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast";
import { dismissToast, useToasts } from "./use-toast";

export function Toaster() {
  const toasts = useToasts();
  return (
    <ToastProvider swipeDirection="right">
      {toasts.map(({ id, title, description, open, variant, duration }) => (
        <Toast
          key={id}
          variant={variant}
          open={open}
          duration={duration ?? 4500}
          onOpenChange={(next) => {
            if (!next) dismissToast(id);
          }}
        >
          <div className="grid gap-1">
            {title ? <ToastTitle>{title}</ToastTitle> : null}
            {description ? (
              <ToastDescription>{description}</ToastDescription>
            ) : null}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
