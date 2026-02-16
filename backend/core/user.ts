import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { writeJsonAtomic, readJsonSafe } from './utils.ts';
import type { LaplaceUser } from '../../types.ts';

export class User {
    private usersFile: string;
    private tokensFile: string; 
    private users: LaplaceUser[] = [];
    private readonly VALID_ROLES = ['admin', 'user', 'guest'];

    constructor(dataDir: string) {
        this.usersFile = path.join(dataDir, 'users.json');
        this.tokensFile = path.join(dataDir, 'tokens.json');
        this.initialize();
    }

    private initialize() {
        if (fs.existsSync(this.usersFile)) {
            this.users = readJsonSafe<LaplaceUser[]>(this.usersFile, []);
        } else if (fs.existsSync(this.tokensFile)) {
            this.migrateLegacy();
        }

        const sysIndex = this.users.findIndex(u => u.role === 'system');
        if (sysIndex !== -1) {
            if (this.users[sysIndex].token !== 'Administrator') {
                this.users[sysIndex].token = 'Administrator';
                this.save();
            }
        } else {
            this.users.unshift({
                id: '00000000-0000-0000-0000-000000000000',
                username: 'system',
                token: 'Administrator',
                role: 'system',
                externalIds: {},
                createdAt: 0,
                volatile: false
            });
            this.save();
        }

        if (this.users.filter(u => u.role === 'admin').length === 0) {
            const initialToken = uuidv4();
            this.users.push({
                id: uuidv4(),
                username: 'admin',
                token: initialToken,
                role: 'admin',
                externalIds: {},
                createdAt: Date.now()
            });
            this.save();
            console.log(`[Auth] Initial Admin Token: ${initialToken}`);
        }
    }

    private migrateLegacy() {
        try {
            const oldData = readJsonSafe(this.tokensFile, { admins: {}, guests: {} });
            Object.entries(oldData.admins || {}).forEach(([name, token]) => {
                this.users.push({ id: uuidv4(), username: name, token: token as string, role: 'admin', externalIds: {}, createdAt: Date.now() });
            });
            Object.values(oldData.guests || {}).forEach((g: any) => {
                this.users.push({ id: uuidv4(), username: 'Guest', token: g.token, role: 'guest', externalIds: {}, createdAt: Date.now(), expiresAt: g.expires });
            });
            this.save();
            fs.renameSync(this.tokensFile, this.tokensFile + '.migrated');
        } catch (e) { console.error("[Auth] Migration failed:", e); }
    }

    private save() {
        try {
            const persistentUsers = this.users.filter(u => !u.volatile);
            writeJsonAtomic(this.usersFile, persistentUsers);
        } catch (e) { console.error("[Auth] Save failed:", e); }
    }

    public authenticate(tokenType: string, credential: string): LaplaceUser | undefined {
        if (!credential) return undefined;
        let user: LaplaceUser | undefined;

        if (tokenType === 'laplace') {
            user = this.users.find(u => u.token === credential);
        } else {
            user = this.users.find(u => u.externalIds && u.externalIds[tokenType] === credential);
        }

        if (!user) return undefined;

        if (user.expiresAt && Date.now() > user.expiresAt) {
            if (user.volatile) {
                this.users = this.users.filter(u => u.id !== user!.id);
            }
            return undefined;
        }

        user.lastActive = Date.now();
        return user;
    }


    public findUser(query: string): LaplaceUser | undefined {
        const q = query.toLowerCase();
        return this.users.find(u => u.id === query || u.username.toLowerCase() === q || u.token === query);
    }

    public registerUser(username: string, role: 'admin' | 'guest' | 'user'): LaplaceUser {
        if (!username || username.trim().length < 3) throw new Error("Username must be at least 3 characters long.");
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) throw new Error("Username can only contain letters, numbers, underscores, and hyphens.");
        if (this.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw new Error(`User '${username}' already exists.`);
        if (!this.VALID_ROLES.includes(role)) throw new Error(`Invalid role '${role}'. Allowed roles: ${this.VALID_ROLES.join(', ')}`);

        const newUser: LaplaceUser = {
            id: uuidv4(),
            username,
            token: uuidv4(),
            role,
            externalIds: {},
            createdAt: Date.now()
        };
        this.users.push(newUser);
        this.save();
        return newUser;
    }

    public deleteUser(query: string): boolean {
        const user = this.findUser(query);
        if (user && user.role === 'system') throw new Error("Cannot delete System Root user.");

        const idx = this.users.findIndex(u => u.id === query || u.username.toLowerCase() === query.toLowerCase());
        if (idx === -1) return false;
        
        this.users.splice(idx, 1);
        this.save();
        return true;
    }

    public rotateToken(query: string): string {
        const user = this.findUser(query);
        if (!user) throw new Error("User not found");
        if (user.role === 'system') throw new Error("Cannot rotate system token");

        user.token = uuidv4();
        if (!user.volatile) this.save();
        return user.token;
    }

    public updateUser(id: string, updates: Partial<LaplaceUser>) {
        const idx = this.users.findIndex(u => u.id === id);
        if (idx === -1) throw new Error("User not found");
        
        this.users[idx] = { ...this.users[idx], ...updates };
        if (!this.users[idx].volatile) this.save();
        return this.users[idx];
    }

    public linkExternal(usernameOrId: string, provider: string, externalValue: string) {
        const user = this.findUser(usernameOrId);
        if (!user) throw new Error(`User '${usernameOrId}' not found.`);

        const existingClaim = this.users.find(u => u.externalIds?.[provider] === externalValue && u.id !== user.id);
        if (existingClaim) {
            throw new Error(`The ${provider} ID '${externalValue}' is already linked to user '${existingClaim.username}'.`);
        }

        if (!user.externalIds) user.externalIds = {};
        user.externalIds[provider] = externalValue;
        
        this.updateUser(user.id, { externalIds: user.externalIds });
        return user;
    }

    public unlinkExternal(usernameOrId: string, provider: string) {
        const user = this.findUser(usernameOrId);
        if (!user) throw new Error(`User '${usernameOrId}' not found.`);
        
        if (user.externalIds && user.externalIds[provider]) {
            delete user.externalIds[provider];
            this.updateUser(user.id, { externalIds: user.externalIds });
            return true;
        }
        throw new Error(`User '${user.username}' is not linked to ${provider}.`);
    }

    public getUsers(): LaplaceUser[] {
        return this.users;
    }
}