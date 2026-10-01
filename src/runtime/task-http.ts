import { Schema } from "effect";
import { getAgentByName } from "agents";
import { TaskRequest, taskKeyPattern } from "../core/task.js";

/** Demo transport. Add authentication and owner authorization before exposing it. */
export async function routeTaskRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const match = /^\/tasks\/([a-zA-Z0-9_-]{1,64})\/jobs\/([a-zA-Z0-9_-]{1,64})(\/approve)?$/.exec(
    new URL(request.url).pathname,
  );
  if (match) {
    const [, owner, key, approval] = match;
    if (!owner || !key || !taskKeyPattern.test(key))
      return new Response("Invalid task key", { status: 400 });
    const agent = await getAgentByName(env.TaskAgent, owner);
    if (request.method === "PUT" && !approval) {
      let body: unknown;
      try {
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (reader) {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            bytes += item.value.length;
            if (bytes > 16_384) {
              await reader.cancel();
              return new Response("Request too large", { status: 413 });
            }
            chunks.push(item.value);
          }
        }
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        body = JSON.parse(new TextDecoder().decode(data));
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      const validated = Schema.decodeUnknownResult(TaskRequest)(body);
      if (validated._tag === "Failure")
        return new Response("Invalid task request", { status: 400 });
      try {
        const record = await agent.submitTask(key, validated.success);
        return Response.json(record, { status: 202 });
      } catch (error) {
        if (error instanceof Error && error.message.includes("different request"))
          return new Response("Task key conflict", { status: 409 });
        return new Response("Acceptance unavailable; retry with the same key", { status: 503 });
      }
    }
    try {
      if (request.method === "GET" && !approval) {
        const record = await agent.getTask(key);
        return record ? Response.json(record) : new Response("Task not found", { status: 404 });
      }
      if (request.method === "DELETE" && !approval) {
        const record = await agent.cancelTask(key);
        return record ? Response.json(record) : new Response("Task not found", { status: 404 });
      }
      if (request.method === "POST" && approval) {
        const record = await agent.getTask(key);
        if (!record) return new Response("Task not found", { status: 404 });
        if (record.status !== "waiting" || !record.request.requireApproval)
          return new Response("Task is not waiting for approval", { status: 409 });
        await agent.approveTask(key);
        return new Response(null, { status: 202 });
      }
    } catch {
      return new Response("Task service temporarily unavailable", { status: 503 });
    }
    return new Response("Method not allowed", { status: 405 });
  }
  return null;
}
