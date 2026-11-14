// src/services/resumeUploadService.ts
import axiosClient from '../utils/axiosClient.js';

export interface IUploadResult {
  sessionId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  status: string;
  uploadPath: string;
  createdAt: Date;
}

export interface ISessionStatus {
  sessionId: string;
  currentStage: string;
  progress: number;
  errors: string[];
  metadata: {
    [key: string]: any;
  };
}

export interface IUploadOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  retries?: number;
  timeout?: number;
}

export const resumeUploadService = {
  /**
   * Upload resume file using unified axiosClient with support for cancellation, retries, timeouts, and progress tracking.
   */
  async uploadResume(file: File, options?: IUploadOptions): Promise<IUploadResult> {
    const formData = new FormData();
    formData.append('resume', file);

    const retries = options?.retries ?? 3;
    const timeout = options?.timeout ?? 30000; // 30s custom timeout for large files

    let attempt = 0;
    while (true) {
      try {
        const response = await axiosClient.post('/resume/upload', formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          timeout,
          signal: options?.signal,
          onUploadProgress: (progressEvent) => {
            if (options?.onProgress && progressEvent.total) {
              const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              options.onProgress(percent);
            }
          },
        });
        return response.data.data;
      } catch (error: any) {
        attempt++;
        // If aborted by user, do not retry
        if (options?.signal?.aborted || error?.code === 'ERR_CANCELED') {
          throw new Error('Upload canceled by user');
        }
        if (attempt >= retries) {
          throw error;
        }
        // Wait with exponential backoff before retrying
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  },

  async resumeSession(sessionId: string): Promise<void> {
    await axiosClient.post(`/resume/sessions/${encodeURIComponent(sessionId)}/resume`);
  },

  /**
   * Get session by ID using unified axiosClient
   */
  async getSession(sessionId: string): Promise<any> {
    const response = await axiosClient.get(`/resume/session/${sessionId}`);
    return response.data;
  },
};

