import { putS3Object } from "~/lib/s3.server";

export async function action({ request, context }: { request: Request, context: any }) {
  const documentId = request.headers.get("X-Document-Id");
  const fileName = request.headers.get("X-File-Name");
  if (!documentId || !fileName) {
    return new Response("Missing document ID or file name", { status: 400 });
  }

  const pdfFile = await request.arrayBuffer();
  try {
    await putS3Object(context.cloudflare.env, b2Key, new Uint8Array(pdfFile));
    return new Response("Upload successful", { status: 200 });
  } catch (e) {
    console.error("[B2 UPLOAD ERROR]", e && (e instanceof Error ? e.stack : e));
    return new Response(`Failed to upload to B2: ${e instanceof Error ? e.message : e}` , { status: 500 });
  }
} 