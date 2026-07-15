import { updateSettings } from "@/lib/server/agent-service";
import { apiError } from "@/lib/server/http";

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      shadowMode?: boolean;
      quietHoursStart?: string;
      quietHoursEnd?: string;
      dailyProactiveBudget?: number;
    };
    return Response.json(await updateSettings(payload));
  } catch (error) {
    return apiError(error);
  }
}
