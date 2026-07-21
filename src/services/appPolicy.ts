export type AppPolicy = {
  appId?: string;
  blocked?: boolean;
  blockedMessage?: string;
  blockedVersions?: string[];
  mandatoryUpdate?: boolean;
  message?: string;
  minVersion?: string;
  schemaVersion?: number;
  version?: string;
};

export const APP_VERSION = "0.2.3";

const APP_POLICY_URLS = [
  "https://raw.githubusercontent.com/boyboyboy321/mpbpo-pdf-studio/main/app-policy.json",
  "https://github.com/boyboyboy321/mpbpo-pdf-studio/releases/latest/download/app-policy.json",
];

function normalizeVersion(version: string) {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(leftVersion: string, rightVersion: string) {
  const left = normalizeVersion(leftVersion);
  const right = normalizeVersion(rightVersion);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

async function fetchPolicy(url: string) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 8_000);

  try {
    const policyUrl = `${url}?v=${encodeURIComponent(APP_VERSION)}&t=${Date.now()}`;
    const response = await fetch(policyUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Could not load app policy (${response.status}).`);
    }

    return (await response.json()) as AppPolicy;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function loadAppPolicy() {
  const errors: unknown[] = [];

  for (const url of APP_POLICY_URLS) {
    try {
      return await fetchPolicy(url);
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  throw new Error(`Could not load app policy from any source (${errors.length} attempts).`);
}

export function getPolicyBlockMessage(policy: AppPolicy | null, currentVersion: string) {
  if (!policy) {
    return null;
  }

  if (policy.blocked) {
    return policy.blockedMessage || "MpBPO PDF Studio dang tam dung truy cap.";
  }

  if (policy.blockedVersions?.includes(currentVersion)) {
    return policy.blockedMessage || "Phien ban nay can duoc cap nhat truoc khi su dung.";
  }

  return null;
}
