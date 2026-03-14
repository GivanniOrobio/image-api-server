import { Router, type IRouter, Request, Response } from "express";
import multer from "multer";
import unzipper from "unzipper";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { db } from "@workspace/db";
import { studiesTable, imagesTable, notesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import {
  GetStudyParams,
  GetNotesParams,
  CreateNoteBody,
  CreateNoteParams,
  DeleteNoteParams,
  DeleteStudyParams,
} from "@workspace/api-zod";
import {
  downloadDriveFile,
  getDriveFileMetadata,
  listDriveFolderFiles,
  requireDriveEnabled,
} from "../integrations/google-drive";

const router: IRouter = Router();

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({ storage: multer.memoryStorage() });

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".dcm",
]);

function isImageFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

function getBodyString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

router.get("/", async (_req: Request, res: Response) => {
  const studies = await db.select().from(studiesTable).orderBy(asc(studiesTable.createdAt));

  const studiesWithCounts = await Promise.all(
    studies.map(async (study) => {
      const images = await db
        .select()
        .from(imagesTable)
        .where(eq(imagesTable.studyId, study.id));
      return {
        id: study.id,
        shareToken: study.shareToken,
        patientName: study.patientName,
        patientId: study.patientId,
        patientDob: study.patientDob,
        studyDescription: study.studyDescription,
        studyDate: study.studyDate,
        imageCount: images.length,
        createdAt: study.createdAt.toISOString(),
      };
    })
  );

  res.json(studiesWithCounts);
});

router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const patientName = req.body.patientName as string;
  const patientId = req.body.patientId as string;
  const patientDob = req.body.patientDob as string | undefined;
  const studyDescription = req.body.studyDescription as string | undefined;
  const studyDate = req.body.studyDate as string | undefined;

  if (!patientName || !patientId) {
    res.status(400).json({ error: "patientName and patientId are required" });
    return;
  }

  const shareToken = uuidv4().replace(/-/g, "").substring(0, 16);
  const studyDir = path.join(UPLOADS_DIR, shareToken);
  fs.mkdirSync(studyDir, { recursive: true });

  const [study] = await db
    .insert(studiesTable)
    .values({
      shareToken,
      patientName,
      patientId,
      patientDob: patientDob || null,
      studyDescription: studyDescription || null,
      studyDate: studyDate || null,
    })
    .returning();

  const imageFiles: { filename: string; storagePath: string; order: number }[] = [];
  let orderIndex = 0;

  try {
    const directory = await unzipper.Open.buffer(file.buffer);
    const sortedFiles = directory.files.sort((a, b) => a.path.localeCompare(b.path));

    for (const entry of sortedFiles) {
      const entryName = path.basename(entry.path);
      if (entry.type === "File" && isImageFile(entryName)) {
        const destPath = path.join(studyDir, `${orderIndex}_${entryName}`);
        const content = await entry.buffer();
        fs.writeFileSync(destPath, content);
        imageFiles.push({
          filename: entryName,
          storagePath: destPath,
          order: orderIndex,
        });
        orderIndex++;
      }
    }
  } catch {
    fs.rmdirSync(studyDir, { recursive: true } as any);
    await db.delete(studiesTable).where(eq(studiesTable.id, study.id));
    res.status(400).json({ error: "Invalid zip file or no valid images found" });
    return;
  }

  if (imageFiles.length === 0) {
    fs.rmdirSync(studyDir, { recursive: true } as any);
    await db.delete(studiesTable).where(eq(studiesTable.id, study.id));
    res.status(400).json({ error: "No valid images found in zip file" });
    return;
  }

  await db.insert(imagesTable).values(
    imageFiles.map((img) => ({
      studyId: study.id,
      filename: img.filename,
      storagePath: img.storagePath,
      imageOrder: img.order,
    }))
  );

  res.status(201).json({
    id: study.id,
    shareToken: study.shareToken,
    patientName: study.patientName,
    patientId: study.patientId,
    patientDob: study.patientDob,
    studyDescription: study.studyDescription,
    studyDate: study.studyDate,
    imageCount: imageFiles.length,
    createdAt: study.createdAt.toISOString(),
  });
});

router.post("/import/drive-zip", async (req: Request, res: Response) => {
  const fileId = getBodyString(req.body, "fileId");
  const patientName = getBodyString(req.body, "patientName");
  const patientId = getBodyString(req.body, "patientId");
  if (!fileId || !patientName || !patientId) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    requireDriveEnabled();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Drive not configured" });
    return;
  }

  const patientDob = getBodyString(req.body, "patientDob");
  const studyDescription = getBodyString(req.body, "studyDescription");
  const studyDate = getBodyString(req.body, "studyDate");

  let meta: { name: string; mimeType: string } | undefined;
  try {
    meta = await getDriveFileMetadata(fileId);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Drive error" });
    return;
  }

  const isZip = meta.name.toLowerCase().endsWith(".zip") || meta.mimeType === "application/zip";
  if (!isZip) {
    res.status(400).json({ error: "Drive file is not a .zip" });
    return;
  }

  const shareToken = uuidv4().replace(/-/g, "").substring(0, 16);
  const studyDir = path.join(UPLOADS_DIR, shareToken);
  fs.mkdirSync(studyDir, { recursive: true });

  const [study] = await db
    .insert(studiesTable)
    .values({
      shareToken,
      patientName,
      patientId,
      patientDob: patientDob || null,
      studyDescription: studyDescription || null,
      studyDate: studyDate || null,
    })
    .returning();

  const imageFiles: { filename: string; storagePath: string; order: number }[] = [];
  let orderIndex = 0;

  try {
    const zipBuffer = await downloadDriveFile(fileId);
    const directory = await unzipper.Open.buffer(zipBuffer);
    const sortedFiles = directory.files.sort((a, b) => a.path.localeCompare(b.path));

    for (const entry of sortedFiles) {
      const entryName = path.basename(entry.path);
      if (entry.type === "File" && isImageFile(entryName)) {
        const destPath = path.join(studyDir, `${orderIndex}_${entryName}`);
        const content = await entry.buffer();
        fs.writeFileSync(destPath, content);
        imageFiles.push({
          filename: entryName,
          storagePath: destPath,
          order: orderIndex,
        });
        orderIndex++;
      }
    }
  } catch {
    fs.rmdirSync(studyDir, { recursive: true } as any);
    await db.delete(studiesTable).where(eq(studiesTable.id, study.id));
    res.status(400).json({ error: "Invalid zip file or no valid images found" });
    return;
  }

  if (imageFiles.length === 0) {
    fs.rmdirSync(studyDir, { recursive: true } as any);
    await db.delete(studiesTable).where(eq(studiesTable.id, study.id));
    res.status(400).json({ error: "No valid images found in zip file" });
    return;
  }

  await db.insert(imagesTable).values(
    imageFiles.map((img) => ({
      studyId: study.id,
      filename: img.filename,
      storagePath: img.storagePath,
      imageOrder: img.order,
    })),
  );

  res.status(201).json({
    id: study.id,
    shareToken: study.shareToken,
    patientName: study.patientName,
    patientId: study.patientId,
    patientDob: study.patientDob,
    studyDescription: study.studyDescription,
    studyDate: study.studyDate,
    imageCount: imageFiles.length,
    createdAt: study.createdAt.toISOString(),
  });
});

router.post("/import/drive-folder", async (req: Request, res: Response) => {
  const folderId = getBodyString(req.body, "folderId");
  const patientName = getBodyString(req.body, "patientName");
  const patientId = getBodyString(req.body, "patientId");
  if (!folderId || !patientName || !patientId) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    requireDriveEnabled();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Drive not configured" });
    return;
  }

  const patientDob = getBodyString(req.body, "patientDob");
  const studyDescription = getBodyString(req.body, "studyDescription");
  const studyDate = getBodyString(req.body, "studyDate");

  let driveFiles: { id: string; name: string }[] = [];
  try {
    driveFiles = (await listDriveFolderFiles(folderId))
      .filter((f) => f.id && f.name)
      .map((f) => ({ id: f.id, name: f.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Drive error" });
    return;
  }

  const shareToken = uuidv4().replace(/-/g, "").substring(0, 16);
  const studyDir = path.join(UPLOADS_DIR, shareToken);
  fs.mkdirSync(studyDir, { recursive: true });

  const [study] = await db
    .insert(studiesTable)
    .values({
      shareToken,
      patientName,
      patientId,
      patientDob: patientDob || null,
      studyDescription: studyDescription || null,
      studyDate: studyDate || null,
    })
    .returning();

  const imageFiles: { filename: string; storagePath: string; order: number }[] = [];
  let orderIndex = 0;

  for (const f of driveFiles) {
    const safeName = path.basename(f.name);
    if (!isImageFile(safeName)) continue;

    imageFiles.push({
      filename: safeName,
      storagePath: `drive:${f.id}`,
      order: orderIndex,
    });
    orderIndex++;
  }

  if (imageFiles.length === 0) {
    fs.rmdirSync(studyDir, { recursive: true } as any);
    await db.delete(studiesTable).where(eq(studiesTable.id, study.id));
    res.status(400).json({ error: "No valid images found in folder" });
    return;
  }

  await db.insert(imagesTable).values(
    imageFiles.map((img) => ({
      studyId: study.id,
      filename: img.filename,
      storagePath: img.storagePath,
      imageOrder: img.order,
    })),
  );

  res.status(201).json({
    id: study.id,
    shareToken: study.shareToken,
    patientName: study.patientName,
    patientId: study.patientId,
    patientDob: study.patientDob,
    studyDescription: study.studyDescription,
    studyDate: study.studyDate,
    imageCount: imageFiles.length,
    createdAt: study.createdAt.toISOString(),
  });
});

router.delete("/:shareToken", async (req: Request, res: Response) => {
  const parsed = DeleteStudyParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const study = await db
    .select()
    .from(studiesTable)
    .where(eq(studiesTable.shareToken, parsed.data.shareToken))
    .limit(1);

  if (!study.length) {
    res.status(404).json({ error: "Study not found" });
    return;
  }

  const studyDir = path.join(UPLOADS_DIR, parsed.data.shareToken);
  if (fs.existsSync(studyDir)) {
    fs.rmSync(studyDir, { recursive: true, force: true });
  }

  await db.delete(studiesTable).where(eq(studiesTable.id, study[0].id));

  res.status(204).send();
});

router.get("/:shareToken", async (req: Request, res: Response) => {
  const parsed = GetStudyParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const study = await db
    .select()
    .from(studiesTable)
    .where(eq(studiesTable.shareToken, parsed.data.shareToken))
    .limit(1);

  if (!study.length) {
    res.status(404).json({ error: "Study not found" });
    return;
  }

  const s = study[0];
  const images = await db
    .select()
    .from(imagesTable)
    .where(eq(imagesTable.studyId, s.id))
    .orderBy(asc(imagesTable.imageOrder));

  res.json({
    id: s.id,
    shareToken: s.shareToken,
    patientName: s.patientName,
    patientId: s.patientId,
    patientDob: s.patientDob,
    studyDescription: s.studyDescription,
    studyDate: s.studyDate,
    imageCount: images.length,
    createdAt: s.createdAt.toISOString(),
    images: images.map((img) => ({
      id: img.id,
      filename: img.filename,
      url: `/api/images/${img.id}`,
      order: img.imageOrder,
    })),
  });
});

router.get("/:shareToken/notes", async (req: Request, res: Response) => {
  const parsed = GetNotesParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const study = await db
    .select()
    .from(studiesTable)
    .where(eq(studiesTable.shareToken, parsed.data.shareToken))
    .limit(1);

  if (!study.length) {
    res.status(404).json({ error: "Study not found" });
    return;
  }

  const notes = await db
    .select()
    .from(notesTable)
    .where(eq(notesTable.studyId, study[0].id))
    .orderBy(asc(notesTable.createdAt));

  res.json(
    notes.map((n) => ({
      id: n.id,
      content: n.content,
      author: n.author,
      createdAt: n.createdAt.toISOString(),
    }))
  );
});

router.post("/:shareToken/notes", async (req: Request, res: Response) => {
  const paramsParsed = CreateNoteParams.safeParse(req.params);
  const bodyParsed = CreateNoteBody.safeParse(req.body);

  if (!paramsParsed.success || !bodyParsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const study = await db
    .select()
    .from(studiesTable)
    .where(eq(studiesTable.shareToken, paramsParsed.data.shareToken))
    .limit(1);

  if (!study.length) {
    res.status(404).json({ error: "Study not found" });
    return;
  }

  const [note] = await db
    .insert(notesTable)
    .values({
      studyId: study[0].id,
      content: bodyParsed.data.content,
      author: bodyParsed.data.author || null,
    })
    .returning();

  res.status(201).json({
    id: note.id,
    content: note.content,
    author: note.author,
    createdAt: note.createdAt.toISOString(),
  });
});

router.delete("/:shareToken/notes/:noteId", async (req: Request, res: Response) => {
  const parsed = DeleteNoteParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  await db.delete(notesTable).where(eq(notesTable.id, parsed.data.noteId));
  res.status(204).send();
});

export default router;
