import { sendMessage } from "@/lib/server/agent-service";
import { apiError } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { content?: string };
    return Response.json(await sendMessage(payload.content ?? ""));
  } catch (error) {
    return apiError(error);
  }
}
