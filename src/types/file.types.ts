export interface FileUploadResponse {
  key: string;
  url: string;
  contentType: string;
  size: number;
}

export interface FileMetadataResponse {
  key: string;
  contentType: string | undefined;
  contentLength: number | undefined;
  lastModified: string | undefined;
  etag: string | undefined;
}

export interface PresignedPutUrlResponse {
  url: string;
  key: string;
  contentType: string;
  expiresIn: number;
  publicUrl: string;
}
