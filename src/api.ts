import type { ShengjiAPI } from "../shared/types";

declare global {
  interface Window {
    shengji: ShengjiAPI;
  }
}

export const api = window.shengji;
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        "",
      )
    : "操作失败，请重试";
