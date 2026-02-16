import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { promises as fsPromises } from 'fs';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { MinecraftServer } from './core/minecraft.ts';
import { User } from './core/user.ts';
import { Audit } from './core/audit.ts';
import { Plugin } from './core/plugin.ts';
import { Tui } from './ui/ui.ts';
import { writeJsonAtomic, readJsonSafe } from './core/utils.ts';

import { InternalPlugins } from './internal_plugins.ts';

import type { LaplaceContext, ApiResponse, LaplaceUser } from '../types.ts';

const PORT = 11228; 
const __filename = fileURLToPath(import.meta.url);
const _curDir = path.dirname(__filename);
const APP_ROOT = path.join(_curDir, '..');
const DATA_DIR = path.join(APP_ROOT, 'laplace_data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const PLAYERS_DIR = path.join(DATA_DIR, 'players');
const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    try { fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), `[${new Date().toISOString()}] Uncaught: ${err.message}\n${err.stack}\n`); } catch(e) {}
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection:', reason);
    try { fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), `[${new Date().toISOString()}] Rejection: ${reason}\n`); } catch(e) {}
});

[DATA_DIR, SERVERS_DIR, BACKUPS_DIR, PLAYERS_DIR, PLUGINS_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

if (!fs.existsSync(CONFIG_FILE)) {
    writeJsonAtomic(CONFIG_FILE, { panelPort: PORT, activeServer: null, theme: 'dark' });
}

const getConfig = () => readJsonSafe(CONFIG_FILE, { panelPort: PORT, activeServer: null, theme: 'dark' });
const saveConfig = (data: any) => writeJsonAtomic(CONFIG_FILE, data);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(bodyParser.json());

const users = new User(DATA_DIR);
const audit = new Audit(DATA_DIR);
const mcServer = new MinecraftServer(SERVERS_DIR, users);

const systemLogger = (msg: string, type: 'info' | 'warn' | 'error' = 'info') => {
    if (type === 'error') process.stderr.write(`[System] ${msg}\n`);
};

const validatePath = (requestedPath: string) => {
    const config = getConfig();
    if (!config.activeServer) throw new Error('No active server selected');
    
    const root = path.resolve(path.join(SERVERS_DIR, config.activeServer));
    const target = path.resolve(path.join(root, requestedPath));
    
    if (!target.startsWith(root)) {
        throw new Error('Access denied: Path traversal detected');
    }
    return target;
};

const parseCookies = (request: Request) => {
    const list: Record<string, string> = {};
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach((cookie: string) => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        if (!value) return;
        list[name] = decodeURIComponent(value);
    });
    return list;
};

const parseTokenString = (rawToken: string): { type: string, value: string } => {
    if (!rawToken) return { type: '', value: '' };
    const separatorIndex = rawToken.indexOf('@');
    if (separatorIndex > -1) {
        return {
            type: rawToken.substring(0, separatorIndex),
            value: rawToken.substring(separatorIndex + 1)
        };
    }
    return { type: 'laplace', value: rawToken };
};

const handleRequest = (
    actionType: string,
    descriptionBuilder: (req: Request) => string,
    handler: (req: Request, res: Response, user: LaplaceUser) => Promise<any> | any
) => async (req: Request, res: Response) => {
    let rawToken = (req.query.token as string) || (req.headers['x-auth-token'] as string);
    if (!rawToken) {
        const cookies = parseCookies(req);
        rawToken = cookies['laplace_token'];
    }

    if (!rawToken) return res.status(401).json({ success: false, error: 'Authentication Token Missing' });

    const { type, value } = parseTokenString(rawToken as string);
    const user = users.authenticate(type, value);
    if (!user) return res.status(403).json({ success: false, error: 'Invalid Credentials or Session Expired' });

    try {
        const description = descriptionBuilder(req);
        audit.log(actionType, user.username, description);
    } catch (e) {
        systemLogger(`Audit log failed: ${e}`, 'warn');
    }

    try {
        const result = await handler(req, res, user);
        if (!res.headersSent) {
            const response: ApiResponse = {
                success: true,
                data: result,
                meta: {
                    timestamp: Date.now(),
                    actor: { 
                        id: user.id, 
                        username: user.username, 
                        authType: type, 
                        authId: type !== 'laplace' ? value : undefined 
                    }
                }
            };
            res.json(response);
        }
    } catch (e: any) {
        if ((req as any).file && (req as any).file.path) {
            try { await fsPromises.unlink((req as any).file.path); } catch (err) {}
        }

        if (!res.headersSent) {
            const msg = e.message || 'Unknown Error';
            let status = 500;
            if (msg.includes('No active server')) status = 409;
            else if (msg.includes('not found') || msg.includes('ENOENT')) status = 404;
            else if (msg.includes('Access denied') || msg.includes('Traversal')) status = 403;
            else if (msg.includes('Invalid') || msg.includes('required')) status = 400;

            res.status(status).json({ success: false, error: msg });
        }
    }
};

const upload = multer({ dest: TEMP_DIR });

app.get('/api/public/info', (req: Request, res: Response) => { 
    try { res.json({ success: true, data: mcServer.getPublicInfo() }); } 
    catch (e: any) { res.status(500).json({ success: false, error: e.message }); } 
});

app.get('/api/auth/check', handleRequest('AUTH_CHECK', () => 'Check', (req, res, user) => ({ valid: true, isAdmin: user.role === 'admin', user })));

app.get('/api/server/status', handleRequest('STATUS_CHECK', () => 'Status', () => {
    const status = mcServer.getStatus(); 
    if (!status.activeServerId) status.activeServerId = getConfig().activeServer; 
    return status;
}));
app.post('/api/server/start', handleRequest('SERVER_START', (req) => `Start ${req.body.serverId}`, async (req, res, user) => {
    const config = getConfig();
    const targetId = req.body.serverId || config.activeServer;
    await mcServer.loadAndStart(targetId, user.username);
    if (config.activeServer !== targetId) { config.activeServer = targetId; saveConfig(config); }
    return { message: 'Start initiated', serverId: targetId };
}));
app.post('/api/server/stop', handleRequest('SERVER_STOP', () => 'Stop', async (req, res, user) => {
    await mcServer.stop(user.username);
    return { message: 'Stop initiated' };
}));
app.post('/api/server/restart', handleRequest('SERVER_RESTART', () => 'Restart', async (req, res, user) => {
    await mcServer.restart(user.username);
    return { message: 'Restart initiated' };
}));
app.get('/api/server/logs/history', handleRequest('LOG_READ', () => 'Logs', async () => {
    const config = getConfig(); 
    if (!config.activeServer) throw new Error('No active server'); 
    const logPath = path.join(SERVERS_DIR, config.activeServer, 'laplace.log'); 
    try {
        return { logs: await fsPromises.readFile(logPath, 'utf-8') };
    } catch (e) {
        return { logs: '' };
    }
}));
app.post('/api/server/create', upload.single('core'), handleRequest('SERVER_CREATE', (req) => `Create ${req.body.name}`, async (req, res, user) => {
    if (!(req as any).file) throw new Error('Core jar required');
    try {
        const serverId = await mcServer.createServer({
            name: req.body.name,
            sourceJarPath: (req as any).file.path,
            eulaAccepted: req.body.eulaAccepted === 'true',
            xmx: req.body.xmx,
            xms: req.body.xms,
            port: req.body.port,
            maxPlayers: req.body.maxPlayers,
            motd: req.body.motd
        });
        try { await fsPromises.unlink((req as any).file.path); } catch(e) {}
        
        const globalConfig = getConfig(); 
        if (!globalConfig.activeServer) { globalConfig.activeServer = serverId; saveConfig(globalConfig); }
        return { message: 'Server created', serverId };
    } catch (e) {
        throw e;
    }
}));
app.get('/api/server/settings', handleRequest('SETTINGS_READ', () => 'Settings', () => mcServer.getSettings()));
app.post('/api/server/settings', handleRequest('SETTINGS_UPDATE', () => 'Update Config', (req, res, user) => {
    mcServer.saveSettings(user.username, req.body);
    return { message: 'Settings saved' };
}));

app.get('/api/files/list', handleRequest('FILE_LIST', (req) => `List ${req.query.path}`, async (req) => {
    const p = validatePath(req.query.path as string || '/'); 
    try {
        const files = await fsPromises.readdir(p);
        const statsPromises = files.map(async (f) => {
            const s = await fsPromises.stat(path.join(p, f));
            return { name: f, path: path.join(req.query.path as string || '/', f).replace(/\\/g, '/'), isDirectory: s.isDirectory(), size: s.size, lastModified: s.mtimeMs };
        });
        return Promise.all(statsPromises);
    } catch (e) {
        return [];
    }
}));
app.get('/api/files/content', handleRequest('FILE_READ', (req) => `Read ${req.query.path}`, async (req) => {
    const p = validatePath(req.query.path as string); 
    const stats = await fsPromises.stat(p);
    if (stats.size > 5 * 1024 * 1024) throw new Error('File too large (Max 5MB)'); 
    return { content: await fsPromises.readFile(p, 'utf-8') };
}));
app.post('/api/files/write', handleRequest('FILE_WRITE', (req) => `Write ${req.body.path}`, async (req) => {
    const p = validatePath(req.body.path);
    await fsPromises.writeFile(p, req.body.content);
    return { message: 'File saved' };
}));
app.post('/api/files/upload', upload.single('file'), handleRequest('FILE_UPLOAD', (req) => `Upload ${(req as any).file?.originalname}`, async (req, res, user) => {
    if (!(req as any).file) throw new Error('No file attached');
    const targetDir = validatePath(req.body.path || '/');
    
    try {
        const stats = await fsPromises.stat(targetDir);
        if (!stats.isDirectory()) throw new Error('Invalid directory path');
    } catch (e) {
        throw new Error('Invalid directory path');
    }
    
    await fsPromises.rename((req as any).file.path, path.join(targetDir, (req as any).file.originalname));
    return { message: 'Uploaded' };
}));
app.post('/api/files/delete', handleRequest('FILE_DELETE', (req) => `Del ${req.body.path}`, async (req) => {
    const p = validatePath(req.body.path); 
    const stats = await fsPromises.lstat(p);
    if (stats.isDirectory()) {
        await fsPromises.rm(p, { recursive: true, force: true });
    } else {
        await fsPromises.unlink(p);
    }
    return { message: 'Deleted' };
}));
app.get('/api/files/download', handleRequest('FILE_DOWNLOAD', (req) => `Download ${req.query.path}`, async (req, res) => {
    const p = validatePath(req.query.path as string); 
    const stats = await fsPromises.lstat(p);
    if (stats.isDirectory()) throw new Error("Directory download not supported"); 
    res.download(p);
}));

app.get('/api/players', handleRequest('PLAYER_LIST', () => 'List Players', async () => await mcServer.getPlayers()));
app.post('/api/players/action', handleRequest('PLAYER_ACTION', (req) => `${req.body.action} ${req.body.name}`, async (req, res, user) => {
    return { message: 'Executed', rconResponse: await mcServer.performPlayerAction(user.username, req.body.name, req.body.action, req.body.payload) };
}));
app.get('/api/backups', handleRequest('BACKUP_LIST', () => 'List Backups', () => mcServer.getBackups()));
app.post('/api/backups/create', handleRequest('BACKUP_CREATE', (req) => `Backup ${req.body.name}`, async (req, res, user) => {
    await mcServer.createBackup(user.username, req.body.name);
    return { message: 'Backup created' };
}));
app.post('/api/backups/delete', handleRequest('BACKUP_DELETE', (req) => `Del Backup ${req.body.id}`, async (req, res, user) => {
    await mcServer.deleteBackup(user.username, req.body.id);
    return { message: 'Backup deleted' };
}));
app.post('/api/backups/restore', handleRequest('BACKUP_RESTORE', (req) => `Restore ${req.body.id}`, async (req, res, user) => {
    await mcServer.restoreBackup(user.username, req.body.id);
    return { message: 'Restored' };
}));
app.get('/api/backups/download', handleRequest('BACKUP_DOWNLOAD', (req) => `Download Backup ${req.query.id}`, async (req, res) => {
    const backupDir = path.join(BACKUPS_DIR, getConfig().activeServer, req.query.id as string);
    try {
        const stats = await fsPromises.stat(backupDir);
        if (stats.isDirectory()) throw new Error("Folder download via HTTP not supported. Use SFTP.");
    } catch (e) {
    }
    res.download(backupDir);
}));

server.on('upgrade', (request, socket, head) => {
    try {
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        const token = url.searchParams.get('token');
        if (token) {
            const { type, value } = parseTokenString(token);
            const user = users.authenticate(type, value);
            if (user) {
                wss.handleUpgrade(request, socket, head, (ws) => { (ws as any).laplaceUser = user; wss.emit('connection', ws, request); });
                return;
            }
        }
    } catch (e) { }
    
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
});

wss.on('connection', (ws: WebSocket) => {
    const user = (ws as any).laplaceUser;
    
    ws.send(JSON.stringify({ type: 'STATUS', payload: mcServer.getStatus() }));
    mcServer.getRecentLogs().forEach(log => ws.send(JSON.stringify({ type: 'LOG', payload: log })));
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'COMMAND') {
                audit.log('CONSOLE_CMD', user.username, `Executed: ${data.command}`);
                await mcServer.executeCommand(user.username, data.command);
            }
        } catch (e) {}
    });
});

mcServer.on('log', (log) => wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type: 'LOG', payload: log }))));
mcServer.on('status', (status) => wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type: 'STATUS', payload: status }))));

const gracefulShutdown = async (signal: string) => {
    systemLogger(`Received ${signal}. Shutting down safely...`);
    try {
        if (mcServer.getStatus().running) {
            systemLogger(`Stopping Minecraft Server...`);
            await mcServer.stop('SYSTEM_SHUTDOWN');
        }
    } catch (e) {
        console.error('Error stopping server:', e);
    }
    
    wss.close();
    server.close(() => {
        systemLogger(`HTTP Server Closed.`);
        process.exit(0);
    });
    
    setTimeout(() => {
        console.error('Forcing shutdown after timeout.');
        process.exit(1);
    }, 10000);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const bootstrap = async () => {
    const tui = new Tui(mcServer, users, null, CONFIG_FILE);
    const pluginContext: LaplaceContext = {
        server: mcServer, users: users, app: app, wss: wss, logger: systemLogger,
        appRoot: APP_ROOT, tui: tui, config: getConfig(), saveConfig: saveConfig
    };
    
    const plugins = new Plugin(PLUGINS_DIR, pluginContext);
    tui.setPlugins(plugins);

    await plugins.loadInternalPlugins(InternalPlugins);
    await plugins.loadAll();

    const cfg = getConfig();
    server.listen(cfg.panelPort || PORT, () => {
        if (cfg.activeServer) {
            try { mcServer.selectServer(cfg.activeServer); } 
            catch(e: any) { systemLogger(`[Init] Auto-load failed: ${e.message}`, 'warn'); }
        }
        tui.start();
    });
};

bootstrap().catch(e => { console.error("FATAL STARTUP ERROR:", e); process.exit(1); });