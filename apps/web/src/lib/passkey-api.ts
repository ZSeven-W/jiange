import { ApiError, type Me } from "@/lib/api";

export interface PasskeySummary {
  id: number;
  name: string;
  credentialId: string;
  aaguid: string;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeyListResponse {
  passkeys: PasskeySummary[];
}

export interface PublicKeyCredentialDescriptorJSON {
  type: PublicKeyCredentialType;
  id: string;
  transports?: AuthenticatorTransport[];
}

export interface PublicKeyCredentialCreationOptionsJSON {
  rp: {
    id: string;
    name: string;
  };
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  challenge: string;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
}

export const PASSKEYS_QUERY_KEY = ["me", "passkeys"] as const;

/** Decodes a standard or unpadded base64url string into an ArrayBuffer. */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  const clean = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (clean.length % 4)) % 4;
  const padded = clean + "=".repeat(padLen);
  const binary =
    typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Encodes an ArrayBuffer or Uint8Array into an unpadded base64url string. */
export function bufferToBase64Url(input: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Reports whether the current browser context supports WebAuthn / Passkeys. */
export function isWebAuthnSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  return (
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}

async function passkeyRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: string }).error ?? "error",
      (data as { message?: string }).message ?? res.statusText,
      data as Record<string, unknown>,
    );
  }
  return data as T;
}

export async function listPasskeys(signal?: AbortSignal): Promise<PasskeySummary[]> {
  const res = await passkeyRequest<PasskeyListResponse>("GET", "/api/me/passkeys", undefined, signal);
  return Array.isArray(res?.passkeys) ? res.passkeys : [];
}

export async function deletePasskey(id: number): Promise<void> {
  await passkeyRequest<void>("DELETE", `/api/me/passkeys/${id}`);
}

export async function registerPasskey(name: string): Promise<PasskeySummary> {
  if (!isWebAuthnSupported()) {
    throw new Error("当前浏览器不支持通行密钥（WebAuthn）");
  }
  const opts = await passkeyRequest<PublicKeyCredentialCreationOptionsJSON>(
    "POST",
    "/api/me/passkeys/register/begin",
    {},
  );

  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: opts.rp,
    user: {
      id: base64UrlToBuffer(opts.user.id),
      name: opts.user.name,
      displayName: opts.user.displayName,
    },
    challenge: base64UrlToBuffer(opts.challenge),
    pubKeyCredParams: opts.pubKeyCredParams,
    timeout: opts.timeout,
    excludeCredentials: (opts.excludeCredentials ?? []).map((item) => ({
      type: item.type,
      id: base64UrlToBuffer(item.id),
      transports: item.transports,
    })),
    authenticatorSelection: opts.authenticatorSelection,
    attestation: opts.attestation,
  };

  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("已取消通行密钥创建");
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === "function" ? response.getTransports() : [];

  return passkeyRequest<PasskeySummary>("POST", "/api/me/passkeys/register/finish", {
    name: name.trim() || "Passkey",
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports,
    },
  });
}

export async function loginWithPasskey(email?: string): Promise<Me> {
  if (!isWebAuthnSupported()) {
    throw new Error("当前浏览器不支持通行密钥（WebAuthn）");
  }
  const trimmedEmail = email?.trim() ?? "";
  const opts = await passkeyRequest<PublicKeyCredentialRequestOptionsJSON>(
    "POST",
    "/api/auth/passkey/login/begin",
    trimmedEmail ? { email: trimmedEmail } : {},
  );

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64UrlToBuffer(opts.challenge),
    timeout: opts.timeout,
    rpId: opts.rpId,
    userVerification: opts.userVerification,
    ...(opts.allowCredentials && opts.allowCredentials.length > 0
      ? {
          allowCredentials: opts.allowCredentials.map((item) => ({
            type: item.type,
            id: base64UrlToBuffer(item.id),
            transports: item.transports,
          })),
        }
      : {}),
  };

  const credential = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("已取消通行密钥验证");
  }

  const response = credential.response as AuthenticatorAssertionResponse;
  return passkeyRequest<Me>("POST", "/api/auth/passkey/login/finish", {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      ...(response.userHandle
        ? { userHandle: bufferToBase64Url(response.userHandle) }
        : {}),
    },
  });
}

export const passkeyApi = {
  isSupported: isWebAuthnSupported,
  list: listPasskeys,
  register: registerPasskey,
  remove: deletePasskey,
  login: loginWithPasskey,
};
