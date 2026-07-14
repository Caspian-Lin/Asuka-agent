import { getSnapshot } from "@/lib/server/agent-service";
import { apiError } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getSnapshot());
  } catch (error) {
    return apiError(error);
  }
}
