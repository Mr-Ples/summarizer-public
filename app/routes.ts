import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/upload.tsx"),
  route("gallery", "routes/gallery.tsx"),
  route("test-tts", "routes/test-tts.tsx"),
  route("api/process", "routes/api.process.tsx"),
  route("api/continue", "routes/api.continue.tsx"),
  route("api/status", "routes/api.status.tsx"),
  route("api/files/original", "routes/api.files.original.tsx"),
  // Note: files route disabled for Cloudflare Workers compatibility
  // route("files/*", "routes/files.$.tsx"),
] satisfies RouteConfig;
