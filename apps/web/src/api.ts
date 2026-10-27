import type { ApiError, ImportResult, TransactionRow } from "@kuberaxis/api/types";

export type { ImportResult, TransactionRow };

export class RequestError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as Partial<ApiError> | null;
    throw new RequestError(error?.error ?? `Request failed (${response.status})`, error?.issues);
  }
  return body as T;
}

export const fetchTransactions = () => request<TransactionRow[]>("/api/transactions");

export function uploadStatement(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  return request<ImportResult>("/api/imports", { method: "POST", body: form });
}

export const purgeData = () => request<{ ok: true }>("/api/data", { method: "DELETE" });
