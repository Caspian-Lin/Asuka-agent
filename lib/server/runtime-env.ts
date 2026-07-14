import { AsyncLocalStorage } from "node:async_hooks";

type RuntimeBindings = Record<string, unknown>;

const runtimeBindings = new AsyncLocalStorage<RuntimeBindings>();

export function runWithRuntimeBindings<T>(
  bindings: RuntimeBindings,
  callback: () => T | Promise<T>,
) {
  return runtimeBindings.run(bindings, callback);
}

export function getRuntimeBinding<T>(name: string): T {
  const binding = runtimeBindings.getStore()?.[name];
  if (!binding) {
    throw new Error(
      `Cloudflare binding \`${name}\` is unavailable in this request context.`,
    );
  }
  return binding as T;
}
