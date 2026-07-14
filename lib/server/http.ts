export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : "发生未知错误";
  return Response.json({ error: message }, { status: 400 });
}
