import { spawn, ChildProcess } from 'child_process';
import { Rcon } from 'rcon-client';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import EventEmitter from 'events';
import { writeJsonAtomic } from './utils.ts';
import type { User } from './user.ts';
import type { LogEntry, ServerConfig, ServerStatus, Player, PlayerActionType, ServerSettingsPayload, BackupItem, PublicServerInfo, ServerCreationParams } from '../../types.ts';

export class MinecraftServer extends EventEmitter {
    private process: ChildProcess | null = null;
    private rcon: Rcon | null = null;
    private config: ServerConfig | null = null;
    private serverDir: string = '';
    private logs: LogEntry[] = [];
    private status: 'OFFLINE' | 'STARTING' | 'ONLINE' | 'STOPPING' | 'RESTARTING' | 'CRASHED' = 'OFFLINE';
    private crashCount: number = 0;
    private intentionToStop: boolean = false;
    private serversDir: string;
    private users: User;
    private readonly MAX_LOGS = 500;
    private onlinePlayers: string[] = [];
    private startTime: number | undefined;
    
    private statusInterval: NodeJS.Timeout | null = null;

    constructor(serversDir: string, users: User) {
        super();
        this.serversDir = serversDir;
        this.users = users;

        process.on('exit', () => {
            if (this.process) this.process.kill();
        });
    }

    public getStatus(): ServerStatus {
        return {
            running: this.status === 'ONLINE' || this.status === 'STARTING' || this.status === 'RESTARTING',
            status: this.status,
            activeServerId: this.config?.id || null,
            serverName: this.config?.name,
            startTime: this.startTime
        };
    }

    public listServers(): {id: string, name: string}[] {
        if (!fs.existsSync(this.serversDir)) return [];
        return fs.readdirSync(this.serversDir)
            .filter(f => {
                const fullPath = path.join(this.serversDir, f);
                return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
            })
            .map(id => {
                const confPath = path.join(this.serversDir, id, 'laplace.server.json');
                if (fs.existsSync(confPath)) {
                    try {
                        const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));
                        return { id, name: conf.name || id };
                    } catch (e) { return { id, name: `Corrupted (${id})` }; }
                }
                return null;
            })
            .filter(x => x !== null) as {id: string, name: string}[];
    }

    public selectServer(serverId: string) {
        const serverPath = path.join(this.serversDir, serverId);
        if (!fs.existsSync(serverPath)) throw new Error('Server ID not found');

        const configPath = path.join(serverPath, 'laplace.server.json');
        if (!fs.existsSync(configPath)) throw new Error('Server configuration corrupted');

        try {
            this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            this.serverDir = serverPath;
            this.emit('status', this.getStatus());
        } catch (e) {
            throw new Error('Failed to parse server config');
        }
    }

    public async createServer(params: ServerCreationParams): Promise<string> {
        if (!fs.existsSync(params.sourceJarPath)) {
            throw new Error(`Core file not found at: ${params.sourceJarPath}`);
        }

        const serverId = params.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const serverPath = path.join(this.serversDir, serverId);

        if (fs.existsSync(serverPath)) {
            throw new Error(`Server ID '${serverId}' already exists. Please choose a different name.`);
        }

        try {
            fs.mkdirSync(serverPath, { recursive: true });
            const destJar = path.join(serverPath, 'server.jar');
            fs.copyFileSync(params.sourceJarPath, destJar);

            if (params.eulaAccepted) {
                fs.writeFileSync(path.join(serverPath, 'eula.txt'), 'eula=true');
            }

            const rconPwd = crypto.randomBytes(8).toString('hex');
            const props = [
                `#Minecraft server properties`,
                `#Created by Laplace Panel`,
                `server-port=${params.port}`,
                `enable-rcon=true`,
                `rcon.port=25575`,
                `rcon.password=${rconPwd}`,
                `max-players=${params.maxPlayers}`,
                `motd=${params.motd}`,
                `online-mode=true`,
                `view-distance=10`
            ].join('\n');
            fs.writeFileSync(path.join(serverPath, 'server.properties'), props);

            const config: ServerConfig = {
                id: serverId,
                name: params.name,
                jarFile: 'server.jar',
                javaArgs: {
                    xmx: params.xmx || '4G',
                    xms: params.xms || '1G',
                    args: ''
                },
                rconPort: 25575,
                rconPassword: rconPwd,
                autoRestart: true,
                created: Date.now()
            };
            
            writeJsonAtomic(path.join(serverPath, 'laplace.server.json'), config);

            this.logSystem(`[System] Server '${params.name}' created successfully (ID: ${serverId}).`);
            this.selectServer(serverId);
            return serverId;

        } catch (e: any) {
            if (fs.existsSync(serverPath) && fs.readdirSync(serverPath).length < 3) {
                try { fs.rmSync(serverPath, { recursive: true, force: true }); } catch (ignored) {}
            }
            this.logError(`[Creation Failed] ${e.message}`);
            throw e;
        }
    }

    public async deleteServer(serverId: string, backupAction: 'DELETE_ALL' | 'KEEP_ALL' | 'KEEP_LATEST') {
        const targetDir = path.join(this.serversDir, serverId);
        
        if (!fs.existsSync(targetDir)) throw new Error("Server ID not found.");
        if (this.config?.id === serverId && this.status !== 'OFFLINE') {
            throw new Error("Cannot delete the active server while it is running. Stop it first.");
        }

        const backupsDir = path.join(path.dirname(this.serversDir), 'backups', serverId);
        if (fs.existsSync(backupsDir)) {
            if (backupAction === 'DELETE_ALL') {
                this.logSystem(`[Delete] Removing all backups for ${serverId}...`);
                fs.rmSync(backupsDir, { recursive: true, force: true });
            } 
            else if (backupAction === 'KEEP_LATEST') {
                this.logSystem(`[Delete] Pruning backups for ${serverId} (Keeping latest)...`);
                const backups = fs.readdirSync(backupsDir)
                    .map(f => ({ name: f, path: path.join(backupsDir, f), time: fs.statSync(path.join(backupsDir, f)).birthtimeMs }))
                    .sort((a, b) => b.time - a.time);

                for (let i = 1; i < backups.length; i++) {
                    fs.rmSync(backups[i].path, { recursive: true, force: true });
                }
            }
        }

        this.logSystem(`[Delete] Removing server files for ${serverId}...`);
        fs.rmSync(targetDir, { recursive: true, force: true });

        if (this.config?.id === serverId) {
            this.config = null;
            this.serverDir = '';
            this.logs = [];
            this.emit('status', this.getStatus());
        }
    }

    public readPropertiesFile(): Record<string, string> {
        if (!this.serverDir) throw new Error("No server selected.");
        const propsPath = path.join(this.serverDir, 'server.properties');
        const properties: Record<string, string> = {};
        
        if (fs.existsSync(propsPath)) {
            const content = fs.readFileSync(propsPath, 'utf-8');
            content.split('\n').forEach(line => {
                line = line.trim();
                if (!line || line.startsWith('#')) return;
                const splitIdx = line.indexOf('=');
                if (splitIdx > -1) {
                    const key = line.substring(0, splitIdx).trim();
                    const val = line.substring(splitIdx + 1).trim();
                    properties[key] = val;
                }
            });
        }
        return properties;
    }

    public writePropertiesFile(properties: Record<string, string>) {
        if (!this.serverDir) throw new Error("No server selected.");
        const propsPath = path.join(this.serverDir, 'server.properties');
        let newContent = "# Minecraft server properties\n# Edited by Laplace Panel\n";
        for (const [key, value] of Object.entries(properties)) {
            newContent += `${key}=${value}\n`;
        }
        fs.writeFileSync(propsPath, newContent);
    }

    private detectCoreType(jarName: string): string {
        const lower = jarName.toLowerCase();
        if (lower.includes('paper')) return 'Paper';
        if (lower.includes('spigot')) return 'Spigot';
        if (lower.includes('forge')) return 'Forge';
        if (lower.includes('fabric')) return 'Fabric';
        return 'Vanilla/Custom';
    }

    private getProperty(key: string, defaultVal: string = ''): string {
        if (!this.serverDir) return defaultVal;
        try {
            const props = this.readPropertiesFile();
            return props[key] !== undefined ? props[key] : defaultVal;
        } catch (e) { return defaultVal; }
    }

    public getPublicInfo(): PublicServerInfo {
        const info: PublicServerInfo = {
            name: this.config?.name || 'Unconfigured Server',
            motd: this.getProperty('motd', 'A Laplace Server'),
            status: this.status,
            version: 'Latest', 
            coreType: this.config ? this.detectCoreType(this.config.jarFile) : 'Unknown',
            players: {
                online: this.onlinePlayers.length,
                max: parseInt(this.getProperty('max-players', '20')),
                list: this.onlinePlayers
            },
            lastUpdated: Date.now()
        };
        return info;
    }

    private updatePublicFile() {
        try {
            const data = this.getPublicInfo();
            const publicPath = path.join(this.serversDir, '..', 'laplace.public.json');
            writeJsonAtomic(publicPath, data);
        } catch (e) { }
    }

    public getRecentLogs(): LogEntry[] {
        return this.logs.slice(-200);
    }

    private getBackupDir(): string {
        const backupDir = path.join(path.dirname(this.serversDir), 'backups', this.config?.id || 'unknown');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        return backupDir;
    }

    public getBackupsForServer(serverId: string): string[] {
        const dir = path.join(path.dirname(this.serversDir), 'backups', serverId);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir);
    }

    public getBackups(): BackupItem[] {
        if (!this.config) return [];
        const dir = this.getBackupDir();
        if (!fs.existsSync(dir)) return [];
        
        return fs.readdirSync(dir).map(f => {
            const fullPath = path.join(dir, f);
            const stat = fs.statSync(fullPath);
            return {
                id: f,
                name: f,
                timestamp: stat.birthtimeMs,
                size: this.getDirSize(fullPath),
                path: fullPath
            };
        }).sort((a, b) => b.timestamp - a.timestamp);
    }

    private getDirSize(dirPath: string): number {
        let size = 0;
        if (fs.existsSync(dirPath)) {
            const files = fs.readdirSync(dirPath);
            files.forEach(file => {
                const fp = path.join(dirPath, file);
                const stats = fs.statSync(fp);
                if (stats.isDirectory()) size += this.getDirSize(fp);
                else size += stats.size;
            });
        }
        return size;
    }

    public async createBackup(actor: string, name?: string) {
        if (!this.serverDir || !this.config) throw new Error("No server loaded");
        if (this.status !== 'OFFLINE') throw new Error("Server must be OFFLINE to create a backup.");
        
        this.logSystem(`[Backup] Process started by user: ${actor}`);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = name ? `${name.replace(/[^a-zA-Z0-9-_]/g, '')}-${timestamp}` : `backup-${timestamp}`;
        const targetDir = path.join(this.getBackupDir(), backupName);

        try {
            fs.cpSync(this.serverDir, targetDir, { 
                recursive: true, 
                filter: (src) => !src.includes('session.lock') 
            });
            this.logSystem(`[Backup] Created snapshot: ${backupName}`);
        } catch (e: any) {
            this.logError(`[Backup] Failed: ${e.message}`);
            throw e;
        }
    }

    public async deleteBackup(actor: string, id: string) {
        const dir = path.join(this.getBackupDir(), id);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            this.logSystem(`[Backup] Snapshot '${id}' deleted by user: ${actor}`);
        }
    }

    public async restoreBackup(actor: string, id: string) {
        if (this.status !== 'OFFLINE') throw new Error("Server must be OFFLINE to restore.");
        
        const backupSource = path.join(this.getBackupDir(), id);
        if (!fs.existsSync(backupSource)) throw new Error("Backup not found");

        this.logSystem(`[Restore] Process initiated by user: ${actor}`);
        this.logSystem(`[Restore] Restoring from ${id}...`);
        
        const files = fs.readdirSync(this.serverDir);
        for (const file of files) {
            fs.rmSync(path.join(this.serverDir, file), { recursive: true, force: true });
        }

        fs.cpSync(backupSource, this.serverDir, { recursive: true });
        this.logSystem(`[Restore] Completed.`);
    }

    public getSettings(): ServerSettingsPayload {
        if (!this.serverDir || !this.config) throw new Error('No server loaded. Please create or select a server.');
        return {
            config: this.config,
            properties: this.readPropertiesFile()
        };
    }

    public saveSettings(actor: string, data: ServerSettingsPayload) {
        if (!this.serverDir || !this.config) throw new Error('No server loaded');

        this.config = { ...this.config, ...data.config };
        
        writeJsonAtomic(
            path.join(this.serverDir, 'laplace.server.json'), 
            this.config
        );

        this.writePropertiesFile(data.properties);
        this.logSystem(`[Config] Server configuration updated by user: ${actor}`);
        this.updatePublicFile();
    }

    private readJsonSafe(filename: string): any[] {
        if (!this.serverDir) return [];
        const target = path.join(this.serverDir, filename);
        if (!fs.existsSync(target)) return [];
        try {
            const content = fs.readFileSync(target, 'utf-8');
            if (!content.trim()) return [];
            return JSON.parse(content);
        } catch (e) { return []; }
    }
    
    private getLaplaceMeta(): Record<string, any> {
        if (!this.serverDir) return {};
        const target = path.join(this.serverDir, 'laplace.players.json');
        if (!fs.existsSync(target)) return {};
        try { return JSON.parse(fs.readFileSync(target, 'utf-8')); } catch (e) { return {}; }
    }

    public async getPlayers(): Promise<Player[]> {
        if (!this.serverDir) return [];
        
        const userCache = this.readJsonSafe('usercache.json');
        const ops = this.readJsonSafe('ops.json');
        const banned = this.readJsonSafe('banned-players.json');
        const whitelist = this.readJsonSafe('whitelist.json');
        const laplaceMeta = this.getLaplaceMeta();
        const playerMap = new Map<string, Player>();

        const getOrInit = (uuid: string, name: string): Player => {
            if (!playerMap.has(uuid)) {
                const linkedManagerUser = this.users 
                    ? this.users.getUsers().find((u) => u.externalIds?.minecraft === uuid)
                    : undefined;
                
                playerMap.set(uuid, {
                    uuid,
                    name,
                    lastLogin: 0,
                    isOnline: false,
                    isOp: false,
                    isBanned: false,
                    isWhitelisted: false,
                    source: 'cache',
                    avatarUrl: `https://minotar.net/helm/${name}/100.png`,
                    meta: laplaceMeta[uuid] || {},
                    linkedUser: linkedManagerUser ? {
                        id: linkedManagerUser.id,
                        username: linkedManagerUser.username,
                        externalIds: linkedManagerUser.externalIds
                    } : undefined
                });
            }
            return playerMap.get(uuid)!;
        };

        userCache.forEach((p: any) => { getOrInit(p.uuid, p.name).source = 'cache'; });
        ops.forEach((p: any) => getOrInit(p.uuid, p.name).isOp = true);
        banned.forEach((p: any) => getOrInit(p.uuid, p.name).isBanned = true);
        whitelist.forEach((p: any) => getOrInit(p.uuid, p.name).isWhitelisted = true);

        this.onlinePlayers = []; 
        if (this.status === 'ONLINE' && this.rcon) {
            try {
                const list = await this.rcon.send('list');
                if (list && list.includes('online:')) {
                    const parts = list.split('online:');
                    if (parts.length > 1 && parts[1].trim().length > 0) {
                        const onlineNames = parts[1].split(',').map(n => n.trim()).filter(n => n.length > 0);
                        this.onlinePlayers = onlineNames;
                        
                        onlineNames.forEach(name => {
                            let found = false;
                            for (const [uuid, p] of playerMap.entries()) {
                                if (p.name.toLowerCase() === name.toLowerCase()) {
                                    p.isOnline = true;
                                    p.lastLogin = Date.now();
                                    found = true;
                                    break;
                                }
                            }
                            if (!found) {
                                const tempId = `online-${name}`;
                                playerMap.set(tempId, {
                                    uuid: tempId,
                                    name: name,
                                    lastLogin: Date.now(),
                                    isOnline: true,
                                    isOp: false,
                                    isBanned: false,
                                    isWhitelisted: false,
                                    source: 'rcon',
                                    avatarUrl: `https://minotar.net/helm/${name}/100.png`
                                });
                            }
                        });
                    }
                }
            } catch (e) { /* RCON busy */ }
        }
        
        this.updatePublicFile();

        return Array.from(playerMap.values()).sort((a, b) => {
            if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
            return b.lastLogin - a.lastLogin;
        });
    }

    public async executeCommand(actor: string, cmd: string): Promise<string> {
        if (this.status !== 'ONLINE' && this.status !== 'STARTING') throw new Error('Server not active. Start it first.');
        
        this.log(`[${actor}] /${cmd}`, 'info');

        if (this.rcon && this.rcon.socket) {
            try { 
                const response = await this.rcon.send(cmd); 
                return response.replace(/§[0-9a-fk-or]/g, '');
            } catch(e: any) { 
                 this.logError(`RCON Error: ${e.message}`);
                 throw e;
            }
        }
        
        if (this.process && this.process.stdin) {
            try {
                this.process.stdin.write(cmd + "\n");
                return "Command sent to process stdin (RCON unavailable).";
            } catch (e) { throw new Error('Failed to write to stdin'); }
        }

        throw new Error("No execution interface available.");
    }

    public async performPlayerAction(actor: string, name: string, action: PlayerActionType, payload?: string) {
        if (this.status !== 'ONLINE') throw new Error('Server must be online to perform actions');
        
        let cmd = '';
        switch (action) {
            case 'kick': cmd = `kick ${name} ${payload || 'Kicked by operator'}`; break;
            case 'ban': cmd = `ban ${name} ${payload || 'Banned by operator'}`; break;
            case 'pardon': cmd = `pardon ${name}`; break;
            case 'op': cmd = `op ${name}`; break;
            case 'deop': cmd = `deop ${name}`; break;
            case 'whitelist_add': cmd = `whitelist add ${name}`; break;
            case 'whitelist_remove': cmd = `whitelist remove ${name}`; break;
            case 'message':
                if (!payload) throw new Error('Message payload required');
                cmd = `tellraw ${name} {"text":"[Server] ${payload}","color":"gold"}`;
                break;
            default: throw new Error('Unknown action');
        }
        
        const response = await this.executeCommand(actor, cmd);
        this.logSystem(`[Action] ${actor}: ${action} on ${name} -> ${response}`);
        return response;
    }

    private log(message: string, type: LogEntry['type'] = 'info') {
        const cleanMsg = message.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').trim();
        if (!cleanMsg) return;

        const entry: LogEntry = { timestamp: new Date().toISOString(), message: cleanMsg, type };
        
        this.logs.push(entry);
        if (this.logs.length > this.MAX_LOGS) this.logs.shift();
        
        if (this.serverDir) {
            try {
                fs.appendFile(
                    path.join(this.serverDir, 'laplace.log'), 
                    `[${entry.timestamp}] [${type.toUpperCase()}] ${cleanMsg}\n`, 
                    (err) => { if (err) console.error('Log write failed:', err); }
                );
            } catch(e) {}
        }
        this.emit('log', entry);
    }

    private logSystem(msg: string) { this.log(msg, 'info'); }
    private logError(msg: string) { this.log(msg, 'error'); }

    public async loadAndStart(serverId: string, actor: string) {
        if (this.status !== 'OFFLINE' && this.status !== 'CRASHED') throw new Error('Server is already running or busy');

        this.selectServer(serverId);
        
        this.crashCount = 0;
        this.intentionToStop = false;
        
        this.updateState('STARTING');
        this.logSystem(`[System] Start command received from user: ${actor}`);
        await this.spawnProcess();
    }
    
    private updateState(newState: ServerStatus['status']) {
        this.status = newState;
        this.emit('status', this.getStatus());
        this.updatePublicFile();
        
        if (newState === 'ONLINE') {
            this.startStatusPoller();
        } else if (newState === 'OFFLINE' || newState === 'CRASHED' || newState === 'STOPPING') {
            this.stopStatusPoller();
        }
    }

    private startStatusPoller() {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
        }
        this.statusInterval = setInterval(() => {
            if (this.status === 'ONLINE') {
                this.getPlayers().catch(() => {});
            }
        }, 5000);
    }

    private stopStatusPoller() {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
    }

    public async restart(actor: string) {
        if (this.status === 'OFFLINE') {
            if (this.config?.id) return this.loadAndStart(this.config.id, actor);
            throw new Error("No active server to start");
        }

        this.updateState('RESTARTING');
        this.logSystem(`[System] Restart command received from user: ${actor}`);

        await this.stop(actor);
        
        let checks = 0;
        while(this.process && checks < 20) {
            await new Promise(r => setTimeout(r, 500));
            checks++;
        }

        if (this.config?.id) {
             setTimeout(() => {
                 this.loadAndStart(this.config!.id, actor).catch(e => {
                     this.logError(`Restart Failed: ${e.message}`);
                     this.updateState('CRASHED');
                 });
             }, 2000);
        }
    }

    private async spawnProcess() {
        if (!this.config) return;
        
        this.updateState('STARTING');
        this.logSystem(`Booting core: ${this.config.name}...`);

        const jarPath = path.join(this.serverDir, this.config.jarFile);
        
        if (!fs.existsSync(jarPath)) {
            this.logError(`FATAL: Server jar not found at ${jarPath}`);
            this.updateState('CRASHED');
            return;
        }

        const customArgs = this.config.javaArgs.args.split(' ').filter(arg => arg.trim().length > 0);
        
        const args = [
            `-Xmx${this.config.javaArgs.xmx}`,
            `-Xms${this.config.javaArgs.xms}`,
            ...customArgs,
            '-jar', jarPath,
            'nogui'
        ];

        this.startTime = Date.now();

        try {
            this.process = spawn('java', args, { cwd: this.serverDir });
        } catch (e: any) {
             this.logError(`Spawn Exception: ${e.message}`);
             this.updateState('CRASHED');
             this.startTime = undefined;
             return;
        }

        this.process.on('error', (err) => {
            this.logError(`FATAL: Failed to spawn Java process. Is Java installed?`);
            this.updateState('CRASHED');
            this.startTime = undefined;
        });

        this.process.stdout?.on('data', (data) => {
            const str = data.toString();
            this.log(str);
            if ((str.includes('Done') && str.includes('!')) || str.includes('Listening on port')) {
                if (this.status !== 'ONLINE') {
                    this.updateState('ONLINE');
                    this.connectRcon();
                }
            }
        });

        this.process.stderr?.on('data', (data) => this.logError(data.toString()));

        this.process.on('close', (code) => {
            this.logSystem(`Process exited with code ${code}`);
            this.cleanup();
            if (!this.intentionToStop && this.status !== 'RESTARTING' && code !== 0 && code !== 130 && code !== 143) {
                this.updateState('CRASHED');
                this.handleCrash();
            } else if (this.status !== 'RESTARTING') {
                this.updateState('OFFLINE');
            }
        });
    }

    private handleCrash() {
        this.crashCount++;
        if (this.crashCount <= 3 && this.config?.autoRestart !== false) {
            this.logError(`Server crashed! Auto-restarting (${this.crashCount}/3) in 5s...`);
            setTimeout(() => {
                if (!this.intentionToStop) this.spawnProcess();
            }, 5000);
        } else {
            this.logError(`Max crash attempts reached. Manual intervention required.`);
        }
    }

    private async connectRcon(attempts = 0) {
        if (this.rcon || !this.config) return;
        if (attempts > 5) return;

        setTimeout(async () => {
             if (!this.config) return;
             try {
                this.rcon = await Rcon.connect({
                    host: 'localhost',
                    port: parseInt(this.config.rconPort.toString()) || 25575,
                    password: this.config.rconPassword || 'minecraft'
                });
                this.logSystem('RCON channel established.');
            } catch (e: any) {
                if (attempts > 2) this.logError(`RCON connection retry (${attempts}/5)...`);
                this.connectRcon(attempts + 1);
            }
        }, 3000);
    }

    public async stop(actor: string = 'System') {
        if (this.status === 'OFFLINE') return;
        this.intentionToStop = true;
        this.updateState('STOPPING');
        this.logSystem(`[System] Stop command received from user: ${actor}`);
        
        if (this.rcon) {
            try { await this.rcon.send('stop'); } catch (e) {}
            for(let i=0; i<20; i++) {
                if (!this.process) break;
                await new Promise(r => setTimeout(r, 500));
            }
            if (this.process) {
                this.logSystem(`[System] Force killing process...`);
                this.process.kill('SIGKILL');
            }
        } else if (this.process) {
             this.process.kill('SIGTERM');
        }
    }

    private cleanup() {
        this.stopStatusPoller();
        if (this.rcon) {
            try {
                this.rcon.end().catch(() => {});
            } catch (e) {}
            this.rcon = null;
        }
        this.process = null;
        this.startTime = undefined;
    }
}