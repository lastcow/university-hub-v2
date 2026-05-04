// Minimal toast store: a typed event emitter that any component can read via
// `useToasts()` or push to via `toast()`. Intentionally smaller than the
// shadcn reference implementation because we don't need toast actions or
// queueing — just enqueue, render, dismiss.

import { useSyncExternalStore } from "react";

import type { ToastProps } from "./toast";

export interface ToastInput {
  title?: string;
  description?: string;
  variant?: ToastProps["variant"];
  duration?: number;
}

export interface ActiveToast extends ToastInput {
  id: string;
  open: boolean;
}

type Listener = (toasts: ActiveToast[]) => void;

const listeners = new Set<Listener>();
let toasts: ActiveToast[] = [];
let nextId = 1;

function emit() {
  for (const fn of listeners) fn(toasts);
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toast(input: ToastInput): string {
  const id = String(nextId++);
  toasts = [...toasts, { ...input, id, open: true }];
  emit();
  return id;
}

export function dismissToast(id: string) {
  toasts = toasts.map((t) => (t.id === id ? { ...t, open: false } : t));
  emit();
  // Drop closed toasts after the animation; Radix unmounts on its own but
  // we want the array to drain so it doesn't grow forever.
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, 400);
}

export function useToasts(): ActiveToast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
}
