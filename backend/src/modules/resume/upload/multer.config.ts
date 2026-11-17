// src/modules/resume-intelligence/upload/multer.config.ts
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import { artifactStorage } from './artifact-storage.js';
import { logger } from '../../../shared/logger.js';

// Configure storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const staging = path.join(artifactStorage.root, 'tmp');
    fs.mkdir(staging, { recursive: true, mode: 0o700 }, error => cb(error, staging));
  },
  filename: (req, file, cb) => {
    // Generate unique filename
    const uniqueSuffix = randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

// Rejected by the file filter. Carries its own status so the error handler returns 415, not 500.
export class UnsupportedFileTypeError extends Error {
  readonly statusCode = 415;
  readonly code = 'UNSUPPORTED_FILE_TYPE';
  constructor() {
    super('Unsupported file type. Upload a PDF, DOCX, TXT or MD file.');
    this.name = 'UnsupportedFileTypeError';
  }
}

// Configure file filter
const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = [
    'application/pdf',
    'application/x-pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
  ];

  const allowedExtensions = ['.pdf', '.docx', '.txt', '.md'];
  const fileExtension = path.extname(file.originalname).toLowerCase();

  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(fileExtension)) {
    cb(null, true);
  } else {
    logger.warn(`[Multer] Rejected file: ${file.originalname} (type: ${file.mimetype})`);
    cb(new UnsupportedFileTypeError());
  }
};

// Create multer instance
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1, // Single file upload
  },
});

// Export single file upload middleware
export const uploadSingle = upload.single('resume');
