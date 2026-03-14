import path from "path";
import { readFile } from "fs/promises";

type OAuthClientJson = {
  web?: {
    client_id?: string;
    client_secret?: string;
    token_uri?: string;
  };
};

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
};

function env(name: string): string | undefined {
  return process.env[name];
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

async function resolveOauthClientJsonPath(): Promise<string> {
  const configured = env("DRIVE_OAUTH_CLIENT_JSON");
  if (configured) return configured;

  const candidates = [
    path.join(process.cwd(), "google.json"),
    path.resolve(process.cwd(), "..", "dicom-viewer", "google.json"),
    path.resolve(process.cwd(), "..", "..", "artifacts", "dicom-viewer", "google.json"),
  ];

  for (const p of candidates) {
    try {
      await readFile(p, "utf8");
      return p;
    } catch {
      // keep searching
    }
  }

  throw new Error(
    "Missing DRIVE_OAUTH_CLIENT_JSON (could not find google.json next to server or in ../dicom-viewer)",
  );
}

async function loadOauthClient(): Promise<{
  clientId: string;
  clientSecret: string;
  tokenUri: string;
}> {
  const oauthJsonContent = env("DRIVE_OAUTH_CLIENT_JSON_CONTENT");
  const sourceLabel = oauthJsonContent ? "DRIVE_OAUTH_CLIENT_JSON_CONTENT" : await resolveOauthClientJsonPath();
  const raw = oauthJsonContent ?? (await readFile(sourceLabel, "utf8"));
  const json = JSON.parse(raw) as OAuthClientJson;
  const clientId = json.web?.client_id;
  const clientSecret = json.web?.client_secret;
  const tokenUri = json.web?.token_uri ?? "https://oauth2.googleapis.com/token";
  if (!clientId || !clientSecret) {
    throw new Error(
      `Invalid OAuth client JSON from ${sourceLabel} (expected web.client_id and web.client_secret)`,
    );
  }
  return { clientId, clientSecret, tokenUri };
}

export async function getDriveAccessToken(): Promise<string> {
  const direct = env("DRIVE_ACCESS_TOKEN");
  if (direct) return direct;

  const refreshToken = env("DRIVE_REFRESH_TOKEN");
  if (!refreshToken) {
    throw new Error(
      "Missing DRIVE_ACCESS_TOKEN (or provide DRIVE_REFRESH_TOKEN + DRIVE_OAUTH_CLIENT_JSON)",
    );
  }

  const oauth = await loadOauthClient();

  const body = new URLSearchParams();
  body.set("client_id", oauth.clientId);
  body.set("client_secret", oauth.clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const res = await fetch(oauth.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token refresh failed ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
    );
  }

  const payload = (await res.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Token refresh response missing access_token");
  return payload.access_token;
}

export async function listDriveFolderFiles(folderId: string): Promise<DriveFile[]> {
  const accessToken = await getDriveAccessToken();

  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  const fields = "nextPageToken,files(id,name,mimeType,size)";

  while (true) {
    const params = new URLSearchParams();
    params.set("q", `'${folderId}' in parents and trashed=false`);
    params.set("pageSize", "1000");
    params.set("fields", fields);
    params.set("supportsAllDrives", "true");
    params.set("includeItemsFromAllDrives", "true");
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Drive list failed ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
      );
    }

    const json = (await res.json()) as {
      nextPageToken?: string;
      files?: DriveFile[];
    };

    if (json.files?.length) files.push(...json.files);
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return files;
}

export async function getDriveFileMetadata(fileId: string): Promise<DriveFile> {
  const accessToken = await getDriveAccessToken();

  const params = new URLSearchParams();
  params.set("fields", "id,name,mimeType,size");
  params.set("supportsAllDrives", "true");

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Drive metadata failed ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
    );
  }

  return (await res.json()) as DriveFile;
}

export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const accessToken = await getDriveAccessToken();

  const params = new URLSearchParams();
  params.set("alt", "media");
  params.set("supportsAllDrives", "true");

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Drive download failed ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`,
    );
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export function classifyDriveFile(name: string, mimeType: string): "zip" | "dicom" | "image" | "other" {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".dcm") || mimeType === "application/dicom") return "dicom";
  if (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".bmp") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".tif") ||
    lower.endsWith(".tiff")
  ) {
    return "image";
  }
  return "other";
}

export function requireDriveEnabled() {
  // Touch required vars early so endpoints can return a clean error.
  // Either DRIVE_ACCESS_TOKEN or DRIVE_REFRESH_TOKEN is required.
  if (!env("DRIVE_ACCESS_TOKEN") && !env("DRIVE_REFRESH_TOKEN")) {
    throw new Error("Drive auth not configured (set DRIVE_ACCESS_TOKEN or DRIVE_REFRESH_TOKEN)");
  }
}
