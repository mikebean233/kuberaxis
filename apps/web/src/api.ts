import type {
  Allocation,
  ApiError,
  ApplyRulesResult,
  Category,
  CategoryKind,
  CategoryRule,
  CategoryRuleInput,
  CategoryUsage,
  ImportResult,
  RuleDirection,
  RuleMatchType,
  RulePreview,
  TransactionItem,
  TransactionItemInput,
  TransactionRow,
} from "@kuberaxis/api/types";

export type {
  Allocation,
  ApplyRulesResult,
  Category,
  CategoryKind,
  CategoryRule,
  CategoryRuleInput,
  CategoryUsage,
  ImportResult,
  RuleDirection,
  RuleMatchType,
  RulePreview,
  TransactionItem,
  TransactionItemInput,
  TransactionRow,
};

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

export const fetchCategories = () => request<Category[]>("/api/categories");

export const createCategory = (name: string, kind?: CategoryKind) =>
  request<Category>("/api/categories", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name, kind }) });

export const fetchCategoryUsage = () => request<Record<number, CategoryUsage>>("/api/categories/usage");

export const deleteCategory = (id: number, moveTo: number | null) =>
  request<{ ok: true }>(`/api/categories/${id}${moveTo === null ? "" : `?moveTo=${moveTo}`}`, { method: "DELETE" });

export const updateCategory = (id: number, change: Pick<Category, "name" | "kind">) =>
  request<Category>(`/api/categories/${id}`, json("PUT", change));

export const fetchTransactionItems = (transactionId: string) => request<TransactionItem[]>(`/api/transactions/${transactionId}/items`);

export const saveTransactionItems = (transactionId: string, items: TransactionItemInput[]) =>
  request<TransactionItem[]>(`/api/transactions/${transactionId}/items`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ items }),
  });

export const setTransactionCategory = (transactionId: string, categoryId: number | null) =>
  request<{ categoryId: number | null; categoryName: string | null }>(`/api/transactions/${transactionId}/category`, json("PUT", { categoryId }));

export const fetchRules = () => request<CategoryRule[]>("/api/rules");
export const createRule = (rule: CategoryRuleInput) => request<CategoryRule>("/api/rules", json("POST", rule));
export const updateRule = (id: number, rule: CategoryRuleInput) => request<CategoryRule>(`/api/rules/${id}`, json("PUT", rule));
export const deleteRule = (id: number) => request<{ ok: true }>(`/api/rules/${id}`, { method: "DELETE" });
export const previewRule = (rule: Pick<CategoryRuleInput, "matchType" | "pattern" | "direction">, signal?: AbortSignal) =>
  request<RulePreview>("/api/rules/preview", { ...json("POST", rule), signal });
export const applyRules = (reapply: boolean) => request<ApplyRulesResult>("/api/rules/apply", json("POST", { reapply }));

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (method: string, body: unknown): RequestInit => ({ method, headers: JSON_HEADERS, body: JSON.stringify(body) });

export function uploadStatement(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  return request<ImportResult>("/api/imports", { method: "POST", body: form });
}

export const purgeData = () => request<{ ok: true }>("/api/data", { method: "DELETE" });
