const CONTROL_API_URL =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://127.0.0.1:3002";

export async function controlRequest<T extends object>(
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(`${CONTROL_API_URL}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const payload = (await response.json()) as T | { error?: string };
  if (!response.ok) {
    throw new Error(
      "error" in payload && payload.error ? payload.error : "控制 API 请求失败",
    );
  }
  return payload as T;
}
