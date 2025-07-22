import type { Route } from "./+types/api.files.original";
import { getS3Object } from "~/lib/s3.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return new Response("Missing PDF key", { status: 400 });
  }
  // --- B2 DOWNLOAD (S3-compatible) ---
  try {
    const obj = await getS3Object(context.cloudflare.env, key);
    const headers = new Headers();
    headers.set("Content-Type", obj.ContentType || "application/pdf");
    headers.set(
      "Content-Disposition",
      obj.ContentDisposition || `attachment; filename=\"${key.split("/").pop()}\"`
    );
    return new Response(obj.Body, { status: 200, headers });
  } catch (e) {
    return new Response("PDF not found", { status: 404 });
  }
} 