declare module "fs" {
  export function rmdirSync(
    path: import("fs").PathLike,
    options?: {
      recursive?: boolean;
      maxRetries?: number;
      retryDelay?: number;
    },
  ): void;
}

