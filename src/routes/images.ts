import { Router, type IRouter, Request, Response } from "express";
import { db } from "@workspace/db";
import { imagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { downloadDriveFile, requireDriveEnabled } from "../integrations/google-drive";

const router: IRouter = Router();

router.get("/:imageId", async (req: Request, res: Response) => {
  const imageId = parseInt(String(req.params.imageId), 10);
  if (isNaN(imageId)) {
    res.status(400).json({ error: "Invalid image ID" });
    return;
  }

  const images = await db
    .select()
    .from(imagesTable)
    .where(eq(imagesTable.id, imageId))
    .limit(1);

  if (!images.length) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  const image = images[0];

  if (image.storagePath.startsWith("drive:")) {
    const fileId = image.storagePath.slice("drive:".length).trim();
    if (!fileId) {
      res.status(500).json({ error: "Invalid drive image reference" });
      return;
    }

    try {
      requireDriveEnabled();
      const buf = await downloadDriveFile(fileId);
      const ext = path.extname(image.filename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
        ".webp": "image/webp",
        ".tiff": "image/tiff",
        ".tif": "image/tiff",
        ".dcm": "application/dicom",
      };

      const mimeType = mimeTypes[ext] || "application/octet-stream";
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(buf);
      return;
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Drive error" });
      return;
    }
  }

  if (!fs.existsSync(image.storagePath)) {
    res.status(404).json({ error: "Image file not found" });
    return;
  }

  const ext = path.extname(image.filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".dcm": "application/dicom",
  };

  const mimeType = mimeTypes[ext] || "application/octet-stream";
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Cache-Control", "public, max-age=86400");

  fs.createReadStream(image.storagePath).pipe(res);
});

export default router;
