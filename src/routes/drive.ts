import { Router, type IRouter, Request, Response } from "express";
import { classifyDriveFile, listDriveFolderFiles, requireDriveEnabled } from "../integrations/google-drive";

const router: IRouter = Router();

router.get("/drive/folders/:folderId/files", async (req: Request, res: Response) => {
  const folderId = String(req.params.folderId ?? "").trim();
  if (folderId.length < 3) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    requireDriveEnabled();
    const files = await listDriveFolderFiles(folderId);
    res.json(
      files
        .filter((f) => f.id && f.name && f.mimeType)
        .map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : null,
          kind: classifyDriveFile(f.name, f.mimeType),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Drive error" });
  }
});

export default router;
