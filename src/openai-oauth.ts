import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { validEmail } from "./account-identity.ts";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
type VerifyIdentity = (token: string, clientId: string, nonce?: string) => Promise<JWTPayload>;

export function openAIIdentityVerifier(key: JWTVerifyGetKey = jwks): VerifyIdentity {
  return async (token, clientId, nonce) => {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: clientId,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== "string" || !payload.sub || (nonce && payload.nonce !== nonce))
      throw new Error("OpenAI identity validation failed");
    return payload;
  };
}
export const verifyOpenAIIdentity = openAIIdentityVerifier();

/** Token exchange metadata is display-only; never merge accounts by email. */
export async function openAICredentialFromResponse(
  data: Record<string, unknown>,
  clientId: string,
  options: {
    nonce?: string;
    previous?: OAuthCredential;
    verify?: VerifyIdentity;
    now?: number;
  } = {},
): Promise<OAuthCredential> {
  if (!clientId || (options.previous?.clientId && options.previous.clientId !== clientId))
    throw new Error("OpenAI registration changed during refresh");
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.refresh_token !== "string" ||
    !data.refresh_token ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    typeof data.scope !== "string"
  )
    throw new Error("Invalid OpenAI token response");
  const scopes = data.scope.trim().split(/\s+/);
  if (!scopes.includes("chatgpt.tokens.use.direct"))
    throw new Error("ChatGPT plan usage was not authorized");
  let email = validEmail(options.previous?.email);
  let subject = options.previous?.subject;
  let idToken = options.previous?.idToken;
  if (typeof data.id_token === "string" && data.id_token) {
    const identity = await (options.verify ?? verifyOpenAIIdentity)(
      data.id_token,
      clientId,
      options.nonce,
    );
    if (typeof identity.sub !== "string" || !identity.sub || (subject && identity.sub !== subject))
      throw new Error("OpenAI account identity changed during refresh");
    subject = identity.sub;
    email = validEmail(identity.email) ?? email;
    idToken = data.id_token;
  } else if (options.nonce) throw new Error("OpenAI sign-in did not return an ID token");
  return {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: (options.now ?? Date.now()) + data.expires_in * 1000 - 180_000,
    clientId,
    scopes,
    ...(email ? { email } : {}),
    ...(subject ? { subject, issuer: ISSUER } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

async function exchange(
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    // Token errors can contain sensitive data. Never show the response body.
    throw new Error(`OpenAI token exchange failed (HTTP ${response.status})`);
  }
  if (Number(response.headers.get("content-length")) > 262144) {
    void response.body?.cancel().catch(() => {});
    throw new Error("OpenAI token response is too large");
  }
  const text = await response.text();
  if (text.length > 262144) throw new Error("OpenAI token response is too large");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid OpenAI token response");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid OpenAI token response");
  return data as Record<string, unknown>;
}

export function parseOpenAICallback(
  input: string,
  state: string,
): { code: string; clientId: string } {
  const url = new URL(input.trim());
  const expected = new URL(REDIRECT_URI);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.searchParams.get("state") !== state
  )
    throw new Error("Invalid OpenAI callback or OAuth state");
  if (url.searchParams.has("error")) throw new Error("ChatGPT authorization was declined");
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!code || !clientId) throw new Error("Missing OpenAI authorization code or issued client ID");
  return { code, clientId };
}

/** Native direct OAuth with validated ID-token metadata retained for account menus. */
export function openAIWithIdentity(verify: VerifyIdentity = verifyOpenAIIdentity) {
  // Pi explicitly aliases providers/all for extensions. Individual provider
  // subpaths otherwise match its pi-ai root alias and resolve under compat.js.
  const provider = builtinProviders().find((candidate) => candidate.id === "openai");
  if (!provider?.auth.oauth) throw new Error("Native OpenAI OAuth provider is unavailable");
  const native = provider.auth.oauth;
  const oauth: OAuthAuth = {
    ...native,
    async login(interaction, options) {
      const deviceId = options?.getDeviceId?.();
      if (
        !deviceId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)
      )
        throw new Error("ChatGPT sign-in requires a stable installation UUID");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        agent_name_hint: "Pi",
        ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPES,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      let server: Server | undefined;
      let complete!: (result: { code: string; clientId: string }) => void;
      let fail!: (error: Error) => void;
      const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
        complete = resolve;
        fail = reject;
      });
      // Observe callback rejection even when the listener cannot start.
      void callback.catch(() => {});
      try {
        server = createServer((request, response) => {
          try {
            const input = new URL(request.url ?? "", REDIRECT_URI);
            if (input.pathname !== "/auth/callback") {
              response.writeHead(404).end();
              return;
            }
            if (input.searchParams.get("state") === state && input.searchParams.has("error"))
              fail(new Error("ChatGPT authorization was declined"));
            const result = parseOpenAICallback(input.toString(), state);
            response
              .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
              .end("ChatGPT connected. Return to Pi.");
            complete(result);
          } catch {
            response
              .writeHead(400, { "Content-Type": "text/plain" })
              .end("Invalid OAuth callback. Return to Pi and try again.");
            // Bad/stale callbacks must not invalidate the live login attempt.
          }
        });
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(1455, process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1", () => {
            server!.removeListener("error", reject);
            server!.on("error", () => fail(new Error("OpenAI callback listener failed")));
            resolve();
          });
        });
      } catch {
        server?.close();
        server = undefined;
        interaction.notify({
          type: "info",
          message: "Callback listener unavailable. Paste the full callback URL after signing in.",
        });
      }
      const manualAbort = new AbortController();
      const cancelled = () => fail(new Error("ChatGPT login cancelled"));
      interaction.signal.addEventListener("abort", cancelled, { once: true });
      try {
        interaction.signal.throwIfAborted();
        interaction.notify({
          type: "auth_url",
          url: url.toString(),
          instructions: "Sign in with ChatGPT. If necessary, paste the full callback URL.",
        });
        const manual = interaction
          .prompt({
            type: "manual_code",
            message: "Complete browser sign-in or paste the full callback URL:",
            placeholder: REDIRECT_URI,
            signal: AbortSignal.any([interaction.signal, manualAbort.signal]),
          })
          .then((input) => parseOpenAICallback(input, state));
        // Callback also carries cancellation when the manual UI ignores its signal.
        const result = await Promise.race([callback, manual]);
        interaction.signal.throwIfAborted();
        const data = await exchange(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: result.clientId,
            code: result.code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
            resource: RESOURCE,
          }),
          interaction.signal,
        );
        return await openAICredentialFromResponse(data, result.clientId, { nonce, verify });
      } finally {
        interaction.signal.removeEventListener("abort", cancelled);
        manualAbort.abort();
        server?.close();
        server?.closeAllConnections();
      }
    },
    async refresh(credential, signal) {
      if (typeof credential.clientId !== "string" || !credential.clientId)
        throw new Error("Reconnect ChatGPT: missing issued client ID");
      const data = await exchange(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credential.clientId,
          refresh_token: credential.refresh,
          resource: RESOURCE,
        }),
        signal,
      );
      return openAICredentialFromResponse(data, credential.clientId, {
        previous: credential,
        verify,
      });
    },
  };
  return { ...provider, auth: { ...provider.auth, oauth } };
}
