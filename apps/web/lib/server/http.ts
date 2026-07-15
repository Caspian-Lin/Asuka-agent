import { errorMessage } from "@asuka-agent/shared";

export function apiError(error: unknown) {
  const message = error ? errorMessage(error) : "发生未知错误";
  return Response.json({ error: message }, { status: 400 });
}
