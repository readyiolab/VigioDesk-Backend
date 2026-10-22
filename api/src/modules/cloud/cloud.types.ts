export type CloudProvider = 'gdrive' | 'dropbox' | 'onedrive' | 'sharepoint' | 'box';

export interface CloudIntegration {
  id: string;
  userId: string;
  provider: CloudProvider;
  accountEmail: string;
  accessToken: string;
  refreshToken?: string | null;
  autoSync: boolean;
  lastSyncAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectCloudDto {
  provider: CloudProvider;
  accountEmail: string;
  accessToken?: string;
  refreshToken?: string;
  code?: string;
  redirectUri?: string;
}

export interface CloudFileItem {
  id: string;
  name: string;
  size: string;
  sizeBytes?: number;
  mimeType?: string;
  isFolder: boolean;
  updatedAt: string;
  providerId: CloudProvider;
  providerName: string;
  type: 'pdf' | 'docx' | 'xlsx' | 'image' | 'folder' | 'other';
  downloadUrl?: string;
  webViewUrl?: string;
  thumbnailUrl?: string;
}

export interface CloudOAuthUrlResponse {
  provider: CloudProvider;
  url: string;
  state?: string;
}

export interface CloudListFilesOptions {
  folderId?: string;
  search?: string;
  filterType?: 'all' | 'pdf' | 'documents' | 'images';
  limit?: number;
}
