import { labelThought } from "@/lib/server/agent-service";
import { apiError } from "@/lib/server/http";

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: string;
      label?: "send_now" | "defer" | "silent";
    };
    if (!payload.id || !payload.label) throw new Error("缺少思绪标注参数");
    return Response.json(await labelThought(payload.id, payload.label));
  } catch (error) {
    return apiError(error);
  }
}
