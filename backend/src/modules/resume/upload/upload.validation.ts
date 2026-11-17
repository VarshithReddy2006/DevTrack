// src/modules/resume-intelligence/upload/upload.validation.ts
import { Request, Response, NextFunction } from 'express';
import { promises as fsPromises } from 'fs';
import { logger } from '../../../shared/logger.js';

/**
 * Validate uploaded file
 */
export async function validateUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No file uploaded',
        code: 'NO_FILE',
      });
      return;
    }

    const errors: string[] = [];

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (req.file.size > maxSize) {
      errors.push('File size exceeds 10MB limit');
    }

    // Check file size (min 1KB)
    if (req.file.size < 1024) {
      errors.push('File size is too small (minimum 1KB)');
    }

    // Check MIME type
    const allowedMimeTypes = [
      'application/pdf',
      'application/x-pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
    ];

    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      errors.push(`Unsupported MIME type: ${req.file.mimetype}`);
    }

    // Check file extension
    const allowedExtensions = ['.pdf', '.docx', '.txt', '.md'];
    const fileExtension = req.file.originalname.toLowerCase().substring(
      req.file.originalname.lastIndexOf('.')
    );

    if (!allowedExtensions.includes(fileExtension)) {
      errors.push(`Unsupported file extension: ${fileExtension}`);
    }

    if (errors.length > 0) {
      logger.warn(`[UploadValidation] Validation failed: ${errors.join(', ')}`);
      // The file is already on disk; nothing downstream will pick it up, so remove it.
      await fsPromises.unlink(req.file.path).catch((e) => {
        logger.warn(`[UploadValidation] Could not remove rejected upload ${req.file?.path}: ${(e as Error).message}`);
      });
      res.status(400).json({
        success: false,
        error: 'File validation failed',
        code: 'VALIDATION_FAILED',
        details: errors,
      });
      return;
    }

    // Security Hardening: Magic Number Validation & Prompt Injection Scan
    try {
      const fs = await import('fs');
      
      // Binary validation for PDF and DOCX
      if (fileExtension === '.pdf' || fileExtension === '.docx') {
        const fd = fs.openSync(req.file.path, 'r');
        const buffer = Buffer.alloc(4);
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);
        
        const hex = buffer.toString('hex').toUpperCase();
        let isValidBinary = false;
        
        if (fileExtension === '.pdf') {
          // PDF Magic Number: %PDF (25 50 44 46)
          isValidBinary = hex.startsWith('25504446');
        } else if (fileExtension === '.docx') {
          // ZIP/DOCX Magic Number: PK\x03\x04 (50 4B 03 04)
          isValidBinary = hex.startsWith('504B0304');
        }
        
        if (!isValidBinary) {
          logger.warn(`[UploadValidation] Magic number mismatch for file: ${req.file.originalname}. Spoofed extension detected.`);
          // Clean up the malicious file
          fs.unlinkSync(req.file.path);
          res.status(400).json({
            success: false,
            error: 'Security verification failed: Invalid file signature.',
            code: 'INVALID_FILE_SIGNATURE',
          });
          return;
        }
      } else {
        // Only run UTF-8 prompt injection scans on text/md files
        const fileContent = fs.readFileSync(req.file.path, 'utf8');

        // Prompt injection signatures
        const injectionSignatures = [
          /ignore\s+all\s+previous\s+instructions/i,
          /system\s+override/i,
          /you\s+are\s+now\s+an\s+admin/i,
          /bypass\s+restrictions/i,
          /override\s+system\s+prompts/i
        ];

        const hasInjection = injectionSignatures.some(sig => sig.test(fileContent));
        if (hasInjection) {
          logger.warn(`[UploadValidation] Malicious prompt injection detected in file: ${req.file.originalname}`);
          fs.unlinkSync(req.file.path);
          res.status(400).json({
            success: false,
            error: 'Security verification failed: Suspicious prompt injection signature detected.',
            code: 'PROMPT_INJECTION_DETECTED',
          });
          return;
        }

        // Simulated Antivirus Signatures
        if (fileContent.includes('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')) {
          logger.error(`[UploadValidation] EICAR Antivirus Test Signature detected!`);
          fs.unlinkSync(req.file.path);
          res.status(400).json({
            success: false,
            error: 'Antivirus scan failed: Malicious file signature detected.',
            code: 'MALWARE_DETECTED',
          });
          return;
        }
      }
    } catch (e) {
      logger.error(`[UploadValidation] Failed to perform deep inspection on ${req.file.originalname}:`, e);
      // We log but continue, or we could fail closed. For beta, we fail closed if validation errors out on read.
      res.status(500).json({
        success: false,
        error: 'Security verification encountered an error processing the file.',
        code: 'INSPECTION_FAILED',
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('[UploadValidation] Validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Validation error',
      code: 'VALIDATION_ERROR',
    });
  }
}
