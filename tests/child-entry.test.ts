import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import accounts from "../index.ts";

it("does not start account management in an OMP child", () => {
  const register = vi.fn(() => { throw new Error("child must not register account hooks"); });
  const pi = {
    on: register,
    events: { on: register, emit: register },
    registerCommand: register,
  } as unknown as ExtensionAPI;
  const interval = vi.spyOn(globalThis, "setInterval");
  try {
    vi.stubEnv("PI_OMP_CHILD", "1");
    accounts(pi);
    expect(register).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  } finally {
    interval.mockRestore();
    vi.unstubAllEnvs();
  }
});
