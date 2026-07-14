import { reviewMemory } from "@/lib/server/agent-service";
import { apiError } from "@/lib/server/http";

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: string;
      action?: "accept" | "reject" | "archive";
    };
    if (!payload.id || !payload.action) throw new Error("缺少记忆操作参数");
    return Response.json(await reviewMemory(payload.id, payload.action));
  } catch (error) {
    return apiError(error);
  }
}
