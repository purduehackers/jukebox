import type { APIRoute } from 'astro';
import { getRuntime } from '../server/runtime.ts';
export const GET: APIRoute = ({ request }) => getRuntime().transport.handle(request);
