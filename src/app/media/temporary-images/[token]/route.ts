import { serveManagedImage } from "@/lib/storage/image-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, context: { params: Promise<{ token: string }> }) { return serveManagedImage(request, context, false, "temporary-images"); }
export function HEAD(request: Request, context: { params: Promise<{ token: string }> }) { return serveManagedImage(request, context, true, "temporary-images"); }
