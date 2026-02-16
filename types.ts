import type { Express } from 'express';
import type { WebSocketServer } from 'ws';

export interface Player {
  uuid: string;
  name: string;
  lastLogin: number;
  isOnline: boolean;
  isOp: boolean;
  isBanned: boolean;
  isWhitelisted: boolean;
  avatarUrl?: string;
  source: 'cache' | 'rcon' | 'ops' | 'whitelist';
  meta?: {
    firstSeen?: number;
    notes?: string;
  };
  linkedUser?: {
      id: string;
      username: string;
      externalIds: Record<string, string>;
  };
}

export interface LaplaceUser {
    id: string;
    username: string;
    token: string;
    role: 'admin' | 'guest' | 'user' | 'system';
    externalIds: Record<string, string>;
    createdAt: number;
    lastActive?: number;
    expiresAt?: number;
    volatile?: boolean;
}

export interface ServerConfig {
  id: string;
  name: string;
  jarFile: string;
  javaArgs: {
    xmx: string;
    xms: string;
    args: string;
  };
  rconPort: number;
  rconPassword?: string;
  autoRestart: boolean;
  created: number;
}

export interface ServerCreationParams {
    name: string;
    sourceJarPath: string;
    port: number;
    maxPlayers: number;
    motd: string;
    xmx: string;
    xms: string;
    eulaAccepted: boolean;
}

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  lastModified: number;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'warn' | 'error' | 'chat';
}

export interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  isAdmin: boolean;
  username: string;
}

export interface ServerStatus {
    running: boolean;
    status: 'OFFLINE' | 'STARTING' | 'ONLINE' | 'STOPPING' | 'RESTARTING' | 'CRASHED';
    activeServerId: string | null;
    serverName?: string;
    startTime?: number;
}

export type WSMessage = 
  | { type: 'LOG', payload: LogEntry }
  | { type: 'STATUS', payload: ServerStatus }
  | { type: 'AUTH_REQUIRED' };

export type PlayerActionType = 'kick' | 'ban' | 'pardon' | 'op' | 'deop' | 'whitelist_add' | 'whitelist_remove' | 'message';

export interface PlayerActionRequest {
    uuid: string;
    name: string;
    action: PlayerActionType;
    payload?: string;
}

export interface ServerSettingsPayload {
    config: ServerConfig;
    properties: Record<string, string>;
}

export interface BackupItem {
    id: string;
    name: string;
    timestamp: number;
    size: number;
    path: string;
}

export interface PublicServerInfo {
    name: string;
    motd: string;
    status: ServerStatus['status'];
    version: string;
    coreType: string;
    players: {
        online: number;
        max: number;
        list: string[];
    };
    lastUpdated: number;
}

export interface TuiInterface {
    registerCommand(command: string, description: string, handler: (args: string[]) => Promise<void> | void): void;
    addHeaderInfo(label: string, value: string): void;
    log(msg: string, color?: string): void;
}

export interface LaplaceContext {
    server: any;
    users: any;
    app: Express;
    wss: WebSocketServer;
    tui: TuiInterface;
    logger: (msg: string, type?: 'info'|'warn'|'error') => void;
    appRoot: string;
    config: any;
    saveConfig: (cfg: any) => void;
}

export interface PluginMetadata {
    name: string;
    version: string;
    author?: string;
    description?: string;
}

export interface LaplacePlugin {
    metadata: PluginMetadata;
    onLoad(ctx: LaplaceContext): void | Promise<void>;
    onUnload?(): void | Promise<void>;
}

export interface ApiAuthInfo {
    type: string;
    credential: string;
}

export interface ApiActor {
    id: string;
    username: string;
    authType: string;
    authId?: string;
}

export interface ApiResponse<T = any> {
    success: boolean;
    message?: string;
    error?: string;
    data?: T;
    meta?: {
        timestamp: number;
        actor: ApiActor;
    };
}