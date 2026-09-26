export function validEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return email.length <= 254 && /^[\x21-\x7e]+$/.test(email) && /^[^@<>]+@[^@<>]+\.[^@<>]+$/.test(email) ? email : undefined;
}

export function credentialEmail(value: Record<string, unknown>): string | undefined {
  const direct = validEmail(value.email);
  if (direct) return direct;
  if (value.type !== "oauth" || typeof value.access !== "string" || value.access.length > 65536) return;
  try {
    const payload = JSON.parse(Buffer.from(value.access.split(".")[1] ?? "", "base64url").toString("utf8"));
    return validEmail(payload?.["https://api.openai.com/profile"]?.email) ?? validEmail(payload?.email);
  } catch { return undefined; }
}
