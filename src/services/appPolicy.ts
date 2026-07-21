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

export const APP_VERSION = "0.2.2";

const APP_POLICY_URL = "https://github.com/boyboyboy321/mpbpo-pdf-studio/releases/latest/download/app-policy.json";

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

export async function loadAppPolicy() {
  const policyUrl = `${APP_POLICY_URL}?v=${encodeURIComponent(APP_VERSION)}&t=${Date.now()}`;
  const response = await fetch(policyUrl, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });

  if (!response.ok) {
    throw new Error(`Could not load app policy (${response.status}).`);
  }

  return (await response.json()) as AppPolicy;
}

export function getPolicyBlockMessage(policy: AppPolicy | null, currentVersion: string) {
  if (!policy) {
    return null;
  }

  if (policy.blocked) {
    return policy.blockedMessage || "MpBPO PDF Studio đang tạm dừng truy cập.";
  }

  if (policy.blockedVersions?.includes(currentVersion)) {
    return policy.blockedMessage || "Phiên bản này cần được cập nhật trước khi sử dụng.";
  }

  if (policy.minVersion && compareVersions(currentVersion, policy.minVersion) < 0) {
    return policy.blockedMessage || `Vui lòng cập nhật lên phiên bản ${policy.minVersion} hoặc mới hơn.`;
  }

  return null;
}
