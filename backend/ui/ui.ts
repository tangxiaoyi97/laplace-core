import readline from 'readline';
import fs from 'fs';
import { MinecraftServer } from '../core/minecraft.ts';
import { User } from '../core/user.ts';
import { writeJsonAtomic } from '../core/utils.ts';
import type { Plugin } from '../core/plugin.ts';
import type { LaplaceUser, ServerCreationParams, TuiInterface } from '../../types.ts';

interface RegisteredCommand {
    name: string;
    description: string;
    usage?: string;
    handler: (args: string[]) => Promise<void> | void;
}

export class Tui implements TuiInterface {
    private rl: readline.Interface;
    private mcServer: MinecraftServer;
    private users: User;
    private plugins: Plugin | null = null;
    private configPath: string;
    private mode: 'MENU' | 'CONSOLE' | 'WIZARD' | 'DELETE_WIZARD' | 'CONFIRM' = 'MENU';
    private systemUser: LaplaceUser;

    private commands: Map<string, RegisteredCommand> = new Map();
    private headerInfo: Map<string, string> = new Map();

    private wizardStep: number = 0;
    private wizardData: Partial<ServerCreationParams> = {};
    
    private deleteTarget: string = '';
    private deleteStep: number = 0;
    private hasBackups: boolean = false;

    private confirmCallback: ((answer: boolean) => void) | null = null;
    private confirmMessage: string = '';

    private styles = {
        reset: '\x1b[0m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        gray: '\x1b[90m',
        bgBlue: '\x1b[44m',
    };

    constructor(mcServer: MinecraftServer, users: User, plugins: Plugin | null, configPath: string) {
        this.mcServer = mcServer;
        this.users = users;
        this.plugins = plugins;
        this.configPath = configPath;

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '',
            completer: () => [[], '']
        });

        const sys = this.users.authenticate('laplace', 'Administrator');
        if (!sys) {
            this.systemUser = { 
                id: '00000000-0000-0000-0000-000000000000',
                username: 'root', 
                role: 'system',
                token: 'Administrator',
                externalIds: {},
                createdAt: 0
            };
        } else {
            this.systemUser = sys;
        }

        this.mcServer.on('log', (entry) => {
            if (this.mode === 'CONSOLE') {
                process.stdout.clearLine(0);
                process.stdout.cursorTo(0);
                const time = entry.timestamp.split('T')[1].split('.')[0];
                const color = entry.type === 'error' ? this.styles.red : entry.type === 'warn' ? this.styles.yellow : this.styles.white;
                console.log(`${this.styles.gray}[${time}]${this.styles.reset} ${color}${entry.message}${this.styles.reset}`);
                this.rl.prompt(true);
            }
        });

        this.registerDefaults();
    }

    public setPlugins(pm: Plugin) { this.plugins = pm; }

    public registerCommand(command: string, description: string, handler: (args: string[]) => Promise<void> | void) {
        this.commands.set(command.toLowerCase(), { name: command, description, handler });
    }

    public addHeaderInfo(label: string, value: string) {
        this.headerInfo.set(label, value);
    }

    public log(msg: string, color: string = this.styles.white) {
        console.log(`${color}${msg}${this.styles.reset}`);
    }

    private printTable(headers: string[], rows: string[][]) {
        if (rows.length === 0) return;
        
        const colWidths = headers.map((h, i) => {
            return Math.max(h.length, ...rows.map(r => (r[i] || '').length)) + 2;
        });

        const buildRow = (cells: string[], style: string = '') => {
            return cells.map((c, i) => (style + (c || '').padEnd(colWidths[i]) + this.styles.reset)).join(' ');
        };

        console.log('');
        console.log(this.styles.dim + buildRow(headers, this.styles.bold + this.styles.blue) + this.styles.reset);
        console.log(this.styles.gray + '─'.repeat(colWidths.reduce((a, b) => a + b + 1, 0)) + this.styles.reset);
        
        rows.forEach(row => {
            console.log(buildRow(row));
        });
        console.log('');
    }

    private success(msg: string) { console.log(`${this.styles.green}✔ ${msg}${this.styles.reset}`); }
    private error(msg: string) { console.log(`${this.styles.red}✘ ${msg}${this.styles.reset}`); }
    private info(msg: string) { console.log(`${this.styles.blue}ℹ ${msg}${this.styles.reset}`); }
    private warn(msg: string) { console.log(`${this.styles.yellow}⚠ ${msg}${this.styles.reset}`); }

    private registerDefaults() {
        this.registerCommand('help', 'Display this help menu', () => this.printHelp());
        this.registerCommand('clear', 'Clear the terminal screen', () => this.printHeader());
        this.registerCommand('exit', 'Shutdown server and exit panel', () => this.handleSystemCommand(['exit']));
        
        this.registerCommand('server', 'Manage server instances', (args) => this.handleServerCommand(args));
        this.registerCommand('player', 'Manage players', (args) => this.handlePlayerCommand(args));
        this.registerCommand('user', 'Manage panel users', (args) => this.handleUserCommand(args));
        this.registerCommand('backup', 'Manage backups', (args) => this.handleBackupCommand(args));
        this.registerCommand('plugin', 'List loaded plugins', (args) => this.handlePluginCommand(args));
    }

    public start() {
        this.printHeader();
        this.updatePrompt();
        this.rl.on('line', async (line) => {
            const input = line.trim();
            try {
                if (this.mode === 'CONSOLE') await this.handleConsoleInput(input);
                else if (this.mode === 'WIZARD') await this.handleWizardInput(input);
                else if (this.mode === 'DELETE_WIZARD') await this.handleDeleteWizardInput(input);
                else if (this.mode === 'CONFIRM') this.handleConfirmInput(input);
                else await this.handleMenuInput(input);
            } catch (e: any) {
                this.error(`Unexpected Error: ${e.message}`);
            }
        });
    }

    private updatePrompt() {
        if (this.mode === 'MENU') this.rl.setPrompt(`${this.styles.bold}${this.styles.blue}laplace${this.styles.reset}@${this.styles.bold}root${this.styles.reset}> `);
        else if (this.mode === 'CONSOLE') this.rl.setPrompt(`${this.styles.magenta}console${this.styles.reset}@${this.styles.bold}${this.mcServer.getStatus().serverName || 'server'}${this.styles.reset}> `);
        else if (this.mode === 'CONFIRM') this.rl.setPrompt(`${this.styles.yellow}(y/n)${this.styles.reset}> `);
        else if (this.mode === 'DELETE_WIZARD') this.rl.setPrompt(`${this.styles.red}delete${this.styles.reset}> `);
        else this.rl.setPrompt(`${this.styles.cyan}wizard${this.styles.reset}[${this.wizardStep}]> `);
        this.rl.prompt();
    }

    private async handleMenuInput(input: string) {
        if (!input) { this.updatePrompt(); return; }
        
        const args: string[] = [];
        let current = '';
        let inQuote = false;
        for (let i = 0; i < input.length; i++) {
            const char = input[i];
            if (char === '"') { inQuote = !inQuote; continue; }
            if (char === ' ' && !inQuote) { if (current) args.push(current); current = ''; }
            else current += char;
        }
        if (current) args.push(current);

        const cmdName = args.shift()?.toLowerCase();

        if (cmdName && this.commands.has(cmdName)) {
            try {
                await this.commands.get(cmdName)!.handler(args);
            } catch (e: any) {
                this.error(e.message);
            }
        } else {
            this.error(`Unknown command '${cmdName}'. Type 'help' for available commands.`);
        }
        this.updatePrompt();
    }

    private printHeader() {
        console.clear();
        const banner = `
    ${this.styles.red}██╗      █████╗ ██████╗ ██╗      █████╗  ██████╗███████╗
    ${this.styles.red}██║     ██╔══██╗██╔══██╗██║     ██╔══██╗██╔════╝██╔════╝
    ${this.styles.red}██║     ███████║██████╔╝██║     ███████║██║     █████╗  
    ${this.styles.red}██║     ██╔══██║██╔═══╝ ██║     ██╔══██║██║     ██╔══╝  
    ${this.styles.red}███████╗██║  ██║██║     ███████╗██║  ██║╚██████╗███████╗
    ${this.styles.red}╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝${this.styles.reset} v15.3 (Stable)
        `;
        console.log(banner);
        
        console.log(`    ${this.styles.green}● SYSTEM ONLINE${this.styles.reset}   PID: ${process.pid}   User: ${this.systemUser.username}`);
        
        this.headerInfo.forEach((val, key) => {
             console.log(`    ${this.styles.cyan}➜ ${key}:${this.styles.reset} ${val}`);
        });
        
        console.log(`\n    ${this.styles.dim}Type 'help' to list commands.${this.styles.reset}\n`);
    }

    private printHelp() {
        console.log(`\n  ${this.styles.bold}AVAILABLE COMMANDS${this.styles.reset}`);
        console.log(`  ${this.styles.dim}──────────────────────────────────────────${this.styles.reset}`);
        
        const sortedCmds = Array.from(this.commands.values()).sort((a,b) => a.name.localeCompare(b.name));
        
        const rows = sortedCmds.map(cmd => [cmd.name, cmd.description]);
        this.printTable(['Command', 'Description'], rows);
    }

    private async handleSystemCommand(args: string[]) {
        if (args[0] === 'exit') {
            process.emit('SIGTERM', 'SIGTERM'); 
        }
    }

    private async handleServerCommand(args: string[]) {
        const sub = args[0]?.toLowerCase();
        
        if (!sub) {
            this.error('Usage: server <create|start|stop|restart|status|list|console|set|delete>');
            return;
        }

        if (sub === 'create') {
            const existingServers = this.mcServer.listServers();
            if (existingServers.length > 0) {
                this.warn(`Operation Blocked: A server instance already exists (${existingServers[0].name}).`);
                this.info(`To maintain system stability, please delete the existing server before creating a new one.`);
                return;
            }

            this.mode = 'WIZARD';
            this.wizardStep = 1;
            this.wizardData = { maxPlayers: 20, motd: 'Laplace Server', xms: '1G' };
            console.log(`\n${this.styles.bgBlue}${this.styles.bold} SERVER CREATION WIZARD ${this.styles.reset}`);
            console.log(`${this.styles.dim}Type 'cancel' at any time to abort.${this.styles.reset}\n`);
            console.log(`${this.styles.cyan}[Step 1]${this.styles.reset} Enter a unique name for your server (a-z, 0-9):`);
            this.updatePrompt();
            return;
        }

        if (sub === 'delete') {
            const serverId = args[1];
            if (!serverId) return this.error("Usage: server delete <name>");
            
            const servers = this.mcServer.listServers();
            if (!servers.find(s => s.id === serverId)) return this.error(`Server '${serverId}' does not exist.`);
            
            const status = this.mcServer.getStatus();
            if (status.activeServerId === serverId && status.running) {
                return this.error("Server is currently running. Stop it before deleting.");
            }

            this.mode = 'DELETE_WIZARD';
            this.deleteTarget = serverId;
            this.deleteStep = 1;
            this.hasBackups = this.mcServer.getBackupsForServer(serverId).length > 0;

            console.log(`\n${this.styles.red}${this.styles.bold} DANGER ZONE: SERVER DELETION ${this.styles.reset}`);
            console.log(`You are about to permanently delete '${serverId}'.`);
            console.log(`Type ${this.styles.bold}'confirm'${this.styles.reset} to proceed or 'cancel' to abort.`);
            this.updatePrompt();
            return;
        }

        if (sub === 'list') {
            const servers = this.mcServer.listServers();
            if (servers.length === 0) return this.warn('No servers found. Use "server create".');
            
            const activeId = this.mcServer.getStatus().activeServerId;
            const rows = servers.map(s => [
                s.id, 
                s.name, 
                s.id === activeId ? `${this.styles.green}ACTIVE${this.styles.reset}` : `${this.styles.dim}IDLE${this.styles.reset}`
            ]);
            this.printTable(['ID', 'Name', 'State'], rows);
            return;
        }

        if (sub === 'status') {
            const status = this.mcServer.getStatus();
            this.log(`\nServer Status: ${status.running ? this.styles.green + 'ONLINE' : this.styles.red + 'OFFLINE'}`);
            this.log(`Name: ${status.serverName || 'None'}`);
            this.log(`State: ${status.status}`);
            return;
        }

        if (sub === 'console') {
            if (!this.mcServer.getStatus().running) return this.error("Server is offline. Start it first.");
            this.mode = 'CONSOLE';
            console.clear();
            console.log(`${this.styles.bgBlue} CONSOLE ATTACHED ${this.styles.reset} Type ':q', 'menu', or 'detach' to exit.`);
            const recents = this.mcServer.getRecentLogs().slice(-10);
            recents.forEach(l => console.log(`[History] ${l.message}`));
            return;
        }

        if (sub === 'set') {
            const prop = args[1];
            const val = args.slice(2).join(' ');
            if (!prop || !val) {
                this.error("Usage: server set <property> <value> (e.g. server set max-players 10)");
                return;
            }
            try {
                const settings = this.mcServer.getSettings();
                settings.properties[prop] = val;
                this.mcServer.saveSettings(this.systemUser.username, settings);
                this.success(`Property '${prop}' updated to '${val}'. Restart required.`);
            } catch (e: any) {
                this.error(e.message);
            }
            return;
        }

        try {
            if (sub === 'start') {
                const id = args[1] || this.mcServer.getStatus().activeServerId || JSON.parse(fs.readFileSync(this.configPath, 'utf-8')).activeServer;
                if (!id) throw new Error("No active server selected. Usage: server start <id>");
                this.info(`Starting server ${id}...`);
                await this.mcServer.loadAndStart(id, this.systemUser.username);
            } 
            else if (sub === 'stop') await this.mcServer.stop(this.systemUser.username);
            else if (sub === 'restart') await this.mcServer.restart(this.systemUser.username);
            else this.error(`Unknown subcommand '${sub}'`);
        } catch (e: any) {
            this.error(e.message);
        }
    }

    private async handlePlayerCommand(args: string[]) {
        const cmd = args[0]?.toLowerCase();
        
        if (!cmd) {
            this.error("Usage: player <list|info|kick|ban|unban|op|deop|whitelist|unwhitelist>");
            return;
        }
        
        if (cmd === 'list') {
            const players = await this.mcServer.getPlayers();
            if (players.length === 0) return this.warn("No player data available.");
            
            const rows = players.map(p => [
                p.name,
                p.isOnline ? this.styles.green + 'ONLINE' + this.styles.reset : this.styles.dim + 'OFFLINE' + this.styles.reset,
                p.isOp ? this.styles.yellow + 'YES' + this.styles.reset : 'NO',
                p.isBanned ? this.styles.red + 'YES' + this.styles.reset : 'NO',
                p.isWhitelisted ? this.styles.cyan + 'YES' + this.styles.reset : 'NO'
            ]);
            this.printTable(['Name', 'Status', 'OP', 'Banned', 'Whitelisted'], rows);
            return;
        }

        if (cmd === 'info') {
            const target = args[1];
            if (!target) return this.error("Usage: player info <name>");
            const players = await this.mcServer.getPlayers();
            const p = players.find(x => x.name.toLowerCase() === target.toLowerCase());
            if (!p) return this.error("Player not found in cache.");
            
            console.log(`\n  ${this.styles.bold}PLAYER INFO: ${p.name}${this.styles.reset}`);
            console.log(`  UUID:        ${p.uuid}`);
            console.log(`  Online:      ${p.isOnline ? this.styles.green + 'YES' + this.styles.reset : 'NO'}`);
            console.log(`  Operator:    ${p.isOp ? this.styles.yellow + 'YES' + this.styles.reset : 'NO'}`);
            console.log(`  Banned:      ${p.isBanned ? this.styles.red + 'YES' + this.styles.reset : 'NO'}`);
            console.log(`  Whitelisted: ${p.isWhitelisted ? this.styles.cyan + 'YES' + this.styles.reset : 'NO'}`);
            if (p.linkedUser) {
                console.log(`  Linked User: ${this.styles.blue}${p.linkedUser.username}${this.styles.reset}`);
            }
            console.log('');
            return;
        }

        const target = args[1];
        if (!target) return this.error(`Usage: player ${cmd} <name> [reason]`);

        try {
            if (cmd === 'kick') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'kick', args.slice(2).join(' '));
            else if (cmd === 'ban') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'ban', args.slice(2).join(' '));
            else if (cmd === 'unban' || cmd === 'pardon') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'pardon');
            else if (cmd === 'op') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'op');
            else if (cmd === 'deop') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'deop');
            else if (cmd === 'unwhitelist') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'whitelist_remove');
            else if (cmd === 'whitelist') {
                const subW = args[2];
                if (subW === 'add') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'whitelist_add');
                else if (subW === 'remove') await this.mcServer.performPlayerAction(this.systemUser.username, target, 'whitelist_remove');
                else this.error("Usage: player whitelist <add|remove> <name>");
            }
            else this.error("Unknown player command.");
        } catch (e: any) {
            this.error(e.message);
        }
    }

    private async handleUserCommand(args: string[]) {
        const cmd = args[0]?.toLowerCase();

        if (!cmd) {
            this.error("Usage: user <list|add|del|token|link|unlink>");
            return;
        }

        if (cmd === 'list') {
            const users = this.users.getUsers();
            const rows = users.map(u => {
                const extKeys = u.externalIds ? Object.keys(u.externalIds) : [];
                return [
                    u.username,
                    u.role,
                    extKeys.length > 0 ? `${extKeys.length} Links` : 'None',
                    `laplace@${u.token.substring(0, 8)}...` // Show correct format hint
                ];
            });
            this.printTable(['Username', 'Role', 'External', 'Auth String'], rows);
            return;
        }

        if (cmd === 'add') {
            const [_, name, role] = args;
            if (!name || !role) return this.error("Usage: user add <username> <admin|user|guest>");
            try {
                const u = this.users.registerUser(name, role as any);
                this.success(`User '${name}' created.`);
                this.info(`Auth String: laplace@${u.token}`);
            } catch (e: any) { this.error(e.message); }
            return;
        }

        if (cmd === 'del') {
            const name = args[1];
            if (!name) return this.error("Usage: user del <username>");
            
            await this.askConfirmation(`Are you sure you want to delete user '${name}'?`);
            this.confirmAction = () => {
                if (this.users.deleteUser(name)) this.success("User deleted.");
                else this.error("User not found.");
            };
            return;
        }

        if (cmd === 'token') {
            const name = args[1];
            if (!name) return this.error("Usage: user token <username>");
            try {
                const newToken = this.users.rotateToken(name);
                this.success(`Token rotated for '${name}'.`);
                this.info(`New Auth String: laplace@${newToken}`);
            } catch (e: any) { this.error(e.message); }
            return;
        }

        if (cmd === 'link') {
            const [_, targetUser, provider, value] = args;
            if (!targetUser || !provider || !value) return this.error("Usage: user link <username> <provider> <value>");
            
            try {
                this.users.linkExternal(targetUser, provider, value);
                this.success(`Linked '${targetUser}' to [${provider}]: ${value}`);
                this.info(`Alt Auth: ${provider}@${value}`);
            } catch(e: any) { this.error(e.message); }
            return;
        }

        if (cmd === 'unlink') {
            const [_, targetUser, provider] = args;
            if (!targetUser || !provider) return this.error("Usage: user unlink <username> <provider>");

            try {
                this.users.unlinkExternal(targetUser, provider);
                this.success(`Unlinked provider [${provider}] from '${targetUser}'`);
            } catch(e: any) { this.error(e.message); }
            return;
        }
    }

    private async handleBackupCommand(args: string[]) {
        const cmd = args[0]?.toLowerCase();
        
        if (!cmd) {
            this.error("Usage: backup <list|create|restore|delete>");
            return;
        }
        
        if (cmd === 'list') {
            const backups = this.mcServer.getBackups();
            if (backups.length === 0) return this.warn("No backups found.");
            const rows = backups.map(b => [
                b.name,
                new Date(b.timestamp).toLocaleString(),
                (b.size / 1024 / 1024).toFixed(2) + ' MB'
            ]);
            this.printTable(['Name', 'Created At', 'Size'], rows);
            return;
        }

        if (cmd === 'create') {
            try {
                await this.mcServer.createBackup(this.systemUser.username, args[1]);
                this.success("Backup created successfully.");
            } catch(e: any) { this.error(e.message); }
            return;
        }

        if (cmd === 'restore') {
            const id = args[1];
            if (!id) return this.error("Usage: backup restore <id>");
            
            await this.askConfirmation(`WARNING: Restoring '${id}' will overwrite current files. Continue?`);
            this.confirmAction = async () => {
                try {
                    await this.mcServer.restoreBackup(this.systemUser.username, id);
                    this.success("Restore complete.");
                } catch(e: any) { this.error(e.message); }
            };
            return;
        }
        
        if (cmd === 'delete') {
            const id = args[1];
             if (!id) return this.error("Usage: backup delete <id>");
             await this.mcServer.deleteBackup(this.systemUser.username, id);
             this.success("Backup deleted.");
        }
    }

    private handlePluginCommand(args: string[]) {
        const cmd = args.length > 0 ? args[0].toLowerCase() : 'list';

        if (cmd !== 'list') {
             this.error("Usage: plugin list");
             return;
        }

        if (!this.plugins) return this.error("Plugin Manager not initialized. Wait for startup to complete.");
        
        try {
            const plugins = this.plugins.getLoadedPlugins();
            if (!plugins || plugins.length === 0) {
                this.warn("No plugins loaded in registry.");
                return;
            }

            const rows = plugins.map((p: any) => [
                p.name || 'Unknown', 
                p.version || '0.0.0', 
                (p.description || 'No description').substring(0, 40) + (p.description?.length > 40 ? '...' : '')
            ]);
            this.printTable(['Plugin Name', 'Version', 'Description'], rows);
        } catch (e: any) {
            this.error(`Failed to retrieve plugins: ${e.message}`);
        }
    }

    private async handleWizardInput(input: string) {
        if (input.toLowerCase() === 'cancel') {
            this.mode = 'MENU';
            this.warn("Wizard cancelled.");
            this.updatePrompt();
            return;
        }

        try {
            switch(this.wizardStep) {
                case 1:
                    const cleanName = input.trim().toLowerCase();
                    if (!cleanName) throw new Error("Server name cannot be empty.");
                    if (cleanName.length < 3) throw new Error("Name is too short (min 3 chars).");
                    if (!/^[a-z0-9-]+$/.test(cleanName)) throw new Error("Name contains invalid characters. Use a-z, 0-9, and hyphens.");
                    
                    this.wizardData.name = cleanName;
                    this.wizardStep++;
                    console.log(`${this.styles.cyan}[Step 2]${this.styles.reset} Enter full path to your server.jar (e.g. /home/user/server.jar):`);
                    break;
                case 2:
                    const cleanPath = input.replace(/^['"]|['"]$/g, '').trim();
                    if (!fs.existsSync(cleanPath)) throw new Error("File does not exist.");
                    if (!cleanPath.toLowerCase().endsWith('.jar')) throw new Error("The selected file must have a .jar extension.");
                    
                    this.wizardData.sourceJarPath = cleanPath;
                    this.wizardStep++;
                    console.log(`${this.styles.cyan}[Step 3]${this.styles.reset} Max RAM (Xmx)? (Press Enter for 4G):`);
                    break;
                case 3:
                    let ram = input.trim().toUpperCase();
                    if (!ram) {
                        ram = '4G';
                        this.info("Using default: 4G");
                    } else if (/^\d+$/.test(ram)) {
                        ram += 'G';
                        this.info(`Unit missing. Assuming Gigabytes: ${ram}`);
                    }
                    
                    if (!/^\d+[GM]$/.test(ram)) {
                        throw new Error("Invalid memory format. Use numbers followed by unit (e.g. 4G, 4096M).");
                    }
                    
                    const memVal = parseInt(ram.slice(0, -1));
                    const memUnit = ram.slice(-1);
                    if (memUnit === 'M' && memVal < 512) this.warn("Warning: <512MB RAM may be insufficient for modern Minecraft.");
                    if (memUnit === 'G' && memVal > 64) this.warn("Warning: Allocating >64GB RAM is unusual.");

                    this.wizardData.xmx = ram;
                    this.wizardStep++;
                    console.log(`${this.styles.cyan}[Step 4]${this.styles.reset} Server Port? (Press Enter for 25565):`);
                    break;
                case 4:
                    const p = input ? parseInt(input) : 25565;
                    if (isNaN(p)) throw new Error("Port must be a valid number.");
                    if (p < 1024 || p > 65535) throw new Error("Port out of range (1024-65535).");
                    this.wizardData.port = p;
                    this.wizardStep++;
                    console.log(`${this.styles.cyan}[Step 5]${this.styles.reset} Do you accept the Minecraft EULA? (y/n):`);
                    break;
                case 5:
                    if (input.toLowerCase() !== 'y') throw new Error("You must accept the EULA to continue.");
                    this.wizardData.eulaAccepted = true;
                    
                    this.info("Creating server... please wait.");
                    const id = await this.mcServer.createServer(this.wizardData as ServerCreationParams);
                    this.success(`Server '${this.wizardData.name}' created! ID: ${id}`);
                    
                    const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                    cfg.activeServer = id;
                    writeJsonAtomic(this.configPath, cfg);
                    this.info("Active server context updated.");
                    
                    this.mode = 'MENU';
                    break;
            }
        } catch (e: any) {
            this.error(e.message);
            switch(this.wizardStep) {
                case 1: console.log("Enter server name (a-z, 0-9):"); break;
                case 2: console.log("Enter full path to server.jar:"); break;
                case 3: console.log("Max RAM (Xmx)? (e.g. 4G, 1024M):"); break;
                case 4: console.log("Server Port? (1024-65535):"); break;
                case 5: console.log("Accept EULA? (y/n):"); break;
            }
        }
        
        if (this.mode === 'WIZARD') this.updatePrompt();
        else this.updatePrompt();
    }

    private async handleDeleteWizardInput(input: string) {
        if (input.toLowerCase() === 'cancel') {
            this.mode = 'MENU';
            this.warn("Delete action aborted.");
            this.updatePrompt();
            return;
        }

        try {
            if (this.deleteStep === 1) {
                if (input !== 'confirm') {
                    throw new Error("You must type 'confirm' exactly to proceed.");
                }

                if (!this.hasBackups) {
                    this.info(`Deleting server '${this.deleteTarget}'...`);
                    await this.mcServer.deleteServer(this.deleteTarget, 'KEEP_ALL');
                    this.success("Server deleted.");
                    
                    const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                    if (cfg.activeServer === this.deleteTarget) {
                        cfg.activeServer = null;
                        writeJsonAtomic(this.configPath, cfg);
                        this.info("Active server selection cleared.");
                    }

                    this.mode = 'MENU';
                } else {
                    this.deleteStep = 2;
                    console.log(`\n${this.styles.yellow}Backups detected for this server.${this.styles.reset}`);
                    console.log("[1] Delete All Backups");
                    console.log("[2] Keep All Backups");
                    console.log("[3] Keep Latest Only");
                    console.log("Enter choice [1-3]:");
                }
            } else if (this.deleteStep === 2) {
                let action: 'DELETE_ALL' | 'KEEP_ALL' | 'KEEP_LATEST';
                
                switch(input.trim()) {
                    case '1': action = 'DELETE_ALL'; break;
                    case '2': action = 'KEEP_ALL'; break;
                    case '3': action = 'KEEP_LATEST'; break;
                    default: throw new Error("Invalid choice. Enter 1, 2, or 3.");
                }

                this.info(`Deleting server '${this.deleteTarget}' with backup action: ${action}...`);
                await this.mcServer.deleteServer(this.deleteTarget, action);
                this.success("Server deleted.");

                 const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                 if (cfg.activeServer === this.deleteTarget) {
                     cfg.activeServer = null;
                     writeJsonAtomic(this.configPath, cfg);
                     this.info("Active server selection cleared.");
                 }

                this.mode = 'MENU';
            }
        } catch (e: any) {
            this.error(e.message);
        }
        
        this.updatePrompt();
    }

    private async handleConsoleInput(input: string) {
        if ([':q', 'exit', 'quit', 'menu', 'detach'].includes(input.toLowerCase())) {
            this.mode = 'MENU';
            console.log(`\n${this.styles.cyan}➜ Detaching console...${this.styles.reset}\n`);
            this.updatePrompt();
            return;
        }
        if (input) await this.mcServer.executeCommand(this.systemUser.username, input);
    }

    private handleConfirmInput(input: string) {
        const yes = input.toLowerCase().startsWith('y');
        this.mode = 'MENU';
        if (yes && this.confirmAction) {
            this.confirmAction();
        } else {
            this.warn("Action cancelled.");
        }
        this.confirmAction = null;
        this.updatePrompt();
    }

    private confirmAction: (() => void) | null = null;

    private askConfirmation(msg: string): Promise<void> {
        return new Promise(resolve => {
            this.confirmMessage = msg;
            this.mode = 'CONFIRM';
            console.log(`${this.styles.yellow}${msg}${this.styles.reset}`);
            this.updatePrompt();
            resolve();
        });
    }
}