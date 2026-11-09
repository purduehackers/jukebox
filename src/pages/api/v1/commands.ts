import type { APIRoute } from 'astro';
import { getRuntime } from '../../../server/runtime.ts';
export const POST: APIRoute = ({ request }) => getRuntime().transport.handle(request);
