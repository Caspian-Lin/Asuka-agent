import { resetDemo } from "@/lib/server/agent-service";
import { apiError } from "@/lib/server/http";

export async function POST() {
  try {
    return Response.json(await resetDemo());
  } catch (error) {
    return apiError(error);
  }
}
