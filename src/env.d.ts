/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** The one queue-authority runtime per server process, set by src/middleware.ts. */
    runtime: import('./server/runtime.ts').Runtime;
  }
}
