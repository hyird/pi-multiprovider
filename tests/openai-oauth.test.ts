import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { credentialEmail } from "../src/account-identity.ts";
import { AccountStore, sameAccount } from "../src/store.ts";
import { createUsageService } from "../src/usage-service.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  openAICredentialFromResponse,
  openAIWithIdentity,
  parseOpenAICallback,
  openAIIdentityVerifier,
} from "../src/openai-oauth.ts";

const response = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
  scope: "openid email chatgpt.tokens.use.direct",
  id_token: "signed-id-token",
};
afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT identity metadata", () => {
  it("verifies real signatures, issuer, audience, expiry and nonce before using email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const verify = openAIIdentityVerifier(createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] }));
    const signed = (issuer = "https://auth.openai.com", expiration = "1h") =>
      new SignJWT({ sub: "user", email: "native@example.com", nonce: "nonce" })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(issuer)
        .setAudience("client")
        .setIssuedAt()
        .setExpirationTime(expiration)
        .sign(privateKey);
    expect((await verify(await signed(), "client", "nonce")).email).toBe("native@example.com");
    await expect(verify(await signed(), "other", "nonce")).rejects.toThrow();
    await expect(verify(await signed(), "client", "wrong")).rejects.toThrow();
    await expect(verify(await signed("https://evil.example"), "client", "nonce")).rejects.toThrow();
    await expect(verify(await signed(undefined, "-1h"), "client", "nonce")).rejects.toThrow();
    const forged = `${(await signed()).split(".").slice(0, 2).join(".")}.invalid`;
    await expect(verify(forged, "client", "nonce")).rejects.toThrow();
  });
  it("synchronizes verified direct-login email into the OMP menu and usage service", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-direct-email-"));
    try {
      const credential = await openAICredentialFromResponse(response, "client", {
        nonce: "nonce",
        verify: async () => ({ sub: "user", email: "native@example.com" }),
      });
      await writeFile(join(dir, "auth.json"), JSON.stringify({ openai: credential }));
      const store = new AccountStore(dir);
      await store.reconcileCurrentAccounts();
      expect(await store.list("openai")).toEqual([
        { name: "default", active: true, email: "native@example.com" },
      ]);
      const service = createUsageService(store);
      const ctx = {
        modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: credential.access } }) },
      } as unknown as ExtensionContext;
      expect(await service.resolveActiveAccountAuth("openai", ctx)).toMatchObject({
        email: "native@example.com",
        accessToken: credential.access,
        authKind: "oauth",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("retains only validated ID-token metadata and preserves it on refresh", async () => {
    const verify = vi.fn(async () => ({ sub: "user-1", email: "native@example.com" }));
    const first = await openAICredentialFromResponse(response, "issued-client", {
      nonce: "nonce",
      verify,
      now: 0,
    });
    expect(verify).toHaveBeenCalledWith("signed-id-token", "issued-client", "nonce");
    expect(first).toMatchObject({
      email: "native@example.com",
      subject: "user-1",
      clientId: "issued-client",
      expires: 3420000,
    });
    expect(credentialEmail(first)).toBe("native@example.com");
    const refreshed = await openAICredentialFromResponse(
      { ...response, id_token: undefined, access_token: "new-access" },
      "issued-client",
      { previous: first, verify },
    );
    expect(refreshed).toMatchObject({
      access: "new-access",
      email: "native@example.com",
      subject: "user-1",
    });
  });
  it("keeps separate direct registrations for the same user and email", () => {
    const a = {
      type: "oauth" as const,
      access: "same-access",
      refresh: "same-refresh",
      clientId: "client-a",
      email: "same@example.com",
    };
    expect(sameAccount(a, { ...a, clientId: "client-b" })).toBe(false);
    expect(sameAccount(a, { ...a })).toBe(true);
  });
  it("keeps legacy access-token email extraction", () => {
    const access = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "legacy@example.com" } })).toString("base64url")}.s`;
    expect(credentialEmail({ type: "oauth", access })).toBe("legacy@example.com");
  });
  it("does not trust invalid identity tokens or cross-account refresh", async () => {
    await expect(
      openAICredentialFromResponse(response, "client", {
        nonce: "nonce",
        verify: async () => {
          throw new Error("signature invalid");
        },
      }),
    ).rejects.toThrow("signature invalid");
    const previous = await openAICredentialFromResponse(response, "client", {
      verify: async () => ({ sub: "first" }),
    });
    await expect(
      openAICredentialFromResponse(response, "client", {
        previous,
        verify: async () => ({ sub: "other", email: "other@example.com" }),
      }),
    ).rejects.toThrow("identity changed");
  });
  it("rejects missing identity and missing sharing permission on login", async () => {
    await expect(
      openAICredentialFromResponse({ ...response, id_token: undefined }, "client", {
        nonce: "nonce",
      }),
    ).rejects.toThrow("ID token");
    await expect(
      openAICredentialFromResponse({ ...response, scope: "openid email" }, "client"),
    ).rejects.toThrow("not authorized");
  });
  it.each([
    "http://127.0.0.1:1455/auth/callback?state=wrong&code=c&client_id=client",
    "https://evil.example/auth/callback?state=state&code=c&client_id=client",
    "http://127.0.0.1:1455/other?state=state&code=c&client_id=client",
    "http://127.0.0.1:1455/auth/callback?state=state&code=c",
  ])("rejects invalid callback %s", (url) => {
    expect(() => parseOpenAICallback(url, "state")).toThrow();
  });
  it("keeps API-key auth and native inference while registering identity-aware OAuth", () => {
    const provider = openAIWithIdentity();
    expect(provider.id).toBe("openai");
    expect(provider.auth.apiKey).toBeDefined();
    expect(provider.streamSimple).toBeTypeOf("function");
    expect(provider.getModels().length).toBeGreaterThan(0);
  });
  it("completes manual login when the callback port is occupied", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(1455, "127.0.0.1", resolve);
    });
    try {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify(response), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchImpl);
      let authorization: URL | undefined;
      const verify = vi.fn(async () => ({ sub: "user", email: "native@example.com" }));
      const credential = await openAIWithIdentity(verify).auth.oauth!.login(
        {
          signal: new AbortController().signal,
          notify: (event) => {
            if (event.type === "auth_url") authorization = new URL(event.url);
          },
          prompt: async () =>
            `http://127.0.0.1:1455/auth/callback?state=${authorization!.searchParams.get("state")}&code=code&client_id=issued-client`,
        },
        { getDeviceId: () => "00000000-0000-4000-8000-000000000001" },
      );
      expect(credential.email).toBe("native@example.com");
      expect(verify).toHaveBeenCalledWith(
        "signed-id-token",
        "issued-client",
        authorization!.searchParams.get("nonce"),
      );
      expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://auth.openai.com/api/accounts/oauth/token");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
